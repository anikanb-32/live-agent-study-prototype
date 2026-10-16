/**
 * Records one study session turn by turn.
 *
 * It listens to the Live client (every server message and every chunk we send)
 * and keeps:
 *   - turns: user + agent transcript, timings, latency estimate, frames, interruption
 *   - events: every non-audio server message plus connect / marker / note events
 *   - frames: every camera JPEG actually sent to the model, with send time
 *   - mic audio and agent audio as PCM, exported as WAV
 *
 * All times are milliseconds since the session started (performance.now based),
 * plus the wall-clock start time in session.json.
 */
import { EventEmitter } from "eventemitter3";
import { LiveConnectConfig, LiveServerMessage } from "@google/genai";
import { GenAILiveClient } from "../lib/genai-live-client";
import {
  AGENT_SAMPLE_RATE,
  MIC_SAMPLE_RATE,
  STUDY_VAD_RMS_THRESHOLD,
} from "./study-config";

export type StudyMeta = {
  participant: string;
  task: string;
  condition: string;
  trial: number;
};

export type Turn = {
  turn_index: number;
  participant: string;
  task: string;
  condition: string;
  trial: number;
  opened_ms: number;
  closed_ms: number | null;
  close_reason: string | null;
  user_transcript: string;
  agent_transcript: string;
  // local voice activity (approximate, from mic RMS)
  user_speech_start_ms: number | null;
  user_speech_end_ms: number | null;
  // server input transcription arrival times
  user_transcript_first_ms: number | null;
  user_transcript_last_ms: number | null;
  agent_first_audio_ms: number | null;
  agent_last_audio_ms: number | null;
  generation_complete_ms: number | null;
  turn_complete_ms: number | null;
  interrupted: boolean;
  latency_ms: number | null;
  latency_source: "vad" | "transcript" | null;
  agent_audio_wav_start_s: number | null;
  agent_audio_wav_end_s: number | null;
  user_audio_wav_start_s: number;
  user_audio_wav_end_s: number | null;
  frames_sent: number;
  first_frame_id: number | null;
  last_frame_id: number | null;
  frame_at_agent_start: number | null;
  markers: string[];
};

type Frame = { id: number; t_ms: number; turn_index: number | null; base64: string };
type LogEvent = { t_ms: number; type: string; data?: unknown };

function emptyTurn(index: number, meta: StudyMeta, t: number, micSamples: number, micRate: number): Turn {
  return {
    turn_index: index,
    participant: meta.participant,
    task: meta.task,
    condition: meta.condition,
    trial: meta.trial,
    opened_ms: t,
    closed_ms: null,
    close_reason: null,
    user_transcript: "",
    agent_transcript: "",
    user_speech_start_ms: null,
    user_speech_end_ms: null,
    user_transcript_first_ms: null,
    user_transcript_last_ms: null,
    agent_first_audio_ms: null,
    agent_last_audio_ms: null,
    generation_complete_ms: null,
    turn_complete_ms: null,
    interrupted: false,
    latency_ms: null,
    latency_source: null,
    agent_audio_wav_start_s: null,
    agent_audio_wav_end_s: null,
    user_audio_wav_start_s: micSamples / micRate,
    user_audio_wav_end_s: null,
    frames_sent: 0,
    first_frame_id: null,
    last_frame_id: null,
    frame_at_agent_start: null,
    markers: [],
  };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rms16(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export class SessionRecorder extends EventEmitter<{ update: () => void }> {
  sessionId = "";
  startedAtIso = "";
  private t0 = 0;
  meta: StudyMeta = { participant: "P00", task: "free", condition: "conversational", trial: 1 };
  model = "";
  config: LiveConnectConfig | null = null;

  turns: Turn[] = [];
  current: Turn | null = null;
  events: LogEvent[] = [];
  frames: Frame[] = [];
  private micChunks: Uint8Array[] = [];
  micSamples = 0;
  micRate = MIC_SAMPLE_RATE;
  lastProblem: string | null = null;
  private agentChunks: Uint8Array[] = [];
  agentSamples = 0;
  private lastSpeechMs: number | null = null;
  private speechActive = false;
  private turnCounter = 0;
  private frameCounter = 0;
  exported = true;
  private detach: (() => void) | null = null;

  constructor() {
    super();
    this.reset();
  }

  now() {
    return Math.round(performance.now() - this.t0);
  }

  reset() {
    const d = new Date();
    this.sessionId = `S${d.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    this.startedAtIso = d.toISOString();
    this.t0 = performance.now();
    this.turns = [];
    this.current = null;
    this.events = [];
    this.frames = [];
    this.micChunks = [];
    this.micSamples = 0;
    this.agentChunks = [];
    this.agentSamples = 0;
    this.lastSpeechMs = null;
    this.speechActive = false;
    this.turnCounter = 0;
    this.frameCounter = 0;
    this.exported = true;
    this.log("session.start", { session_id: this.sessionId, meta: this.meta });
    this.emit("update");
  }

  setMeta(meta: Partial<StudyMeta>) {
    this.meta = { ...this.meta, ...meta };
    this.log("meta.change", this.meta);
    this.emit("update");
  }

  log(type: string, data?: unknown) {
    this.events.push({ t_ms: this.now(), type, data });
    this.exported = false;
  }

  marker(label: string) {
    this.log("marker", label);
    const target = this.current ?? this.turns[this.turns.length - 1];
    if (target) target.markers.push(`${this.now()}ms: ${label}`);
    this.emit("update");
  }

  attach(client: GenAILiveClient) {
    this.detach?.();
    // browsers pause or throttle background tabs, which stops camera frames;
    // record it so a gap in frames.csv can be explained
    const onVisibility = () => {
      this.log("page.visibility", document.visibilityState);
      this.emit("update");
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onRaw = (m: LiveServerMessage, at: number) =>
      this.onServer(m, Math.round(at - this.t0));
    const onInput = (chunks: Array<{ mimeType: string; data: string }>, at: number) =>
      this.onSent(chunks, Math.round(at - this.t0));
    const onOpen = () => {
      this.lastProblem = null;
      this.model = client.model || "";
      this.config = client.getConfig() as LiveConnectConfig;
      this.log("client.open", { model: this.model, config: this.config });
      this.emit("update");
    };
    const onLog = (l: { type: string; message: unknown }) => {
      if (l.type === "client.micError") {
        this.lastProblem = `Microphone: ${l.message}`;
        this.log("mic.error", l.message);
        this.emit("update");
      }
    };
    const onError = (e: ErrorEvent) => {
      this.lastProblem = `Connection error: ${e?.message || "unknown"}`;
      this.log("client.error", e?.message);
      this.emit("update");
    };
    const onClose = (e: CloseEvent) => {
      if (e?.reason) this.lastProblem = `Disconnected: ${e.reason}`;
      this.log("client.close", { code: e?.code, reason: e?.reason });
      this.closeTurn("disconnected");
    };
    client.on("raw", onRaw).on("realtimeinput", onInput).on("open", onOpen).on("close", onClose).on("log", onLog).on("error", onError);
    this.detach = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      client.off("raw", onRaw).off("realtimeinput", onInput).off("open", onOpen).off("close", onClose).off("log", onLog).off("error", onError);
    };
  }

  private openTurn(t: number): Turn {
    if (!this.current) {
      this.turnCounter += 1;
      this.current = emptyTurn(this.turnCounter, this.meta, t, this.micSamples, this.micRate);
    }
    return this.current;
  }

  private closeTurn(reason: string) {
    const turn = this.current;
    if (!turn) return;
    turn.closed_ms = this.now();
    turn.close_reason = reason;
    turn.user_audio_wav_end_s = this.micSamples / this.micRate;
    turn.user_transcript = turn.user_transcript.trim();
    turn.agent_transcript = turn.agent_transcript.trim();
    this.turns.push(turn);
    this.current = null;
    this.emit("update");
  }

  /** the most recent turn in which the agent has spoken */
  private lastAgentTurn(): Turn | null {
    if (this.current?.agent_first_audio_ms != null) return this.current;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].agent_first_audio_ms != null) return this.turns[i];
    }
    return null;
  }

  private onServer(m: LiveServerMessage, t: number) {
    this.exported = false;
    const sc = m.serverContent;
    let audioBytes = 0;

    if (sc?.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        const d = p.inlineData;
        if (d?.data && d.mimeType?.startsWith("audio/pcm")) {
          const bytes = b64ToBytes(d.data);
          audioBytes += bytes.byteLength;
          const turn = this.openTurn(t);
          if (turn.agent_first_audio_ms == null) {
            turn.agent_first_audio_ms = t;
            turn.agent_audio_wav_start_s = this.agentSamples / AGENT_SAMPLE_RATE;
            turn.frame_at_agent_start = this.frames.length
              ? this.frames[this.frames.length - 1].id
              : null;
            // latency: end of user speech (local VAD) -> first agent audio
            if (this.lastSpeechMs != null && this.lastSpeechMs >= turn.opened_ms - 50) {
              turn.user_speech_end_ms = this.lastSpeechMs;
              turn.latency_ms = t - this.lastSpeechMs;
              turn.latency_source = "vad";
            } else if (turn.user_transcript_last_ms != null) {
              turn.latency_ms = t - turn.user_transcript_last_ms;
              turn.latency_source = "transcript";
            }
          }
          turn.agent_last_audio_ms = t;
          this.agentChunks.push(bytes);
          this.agentSamples += bytes.byteLength / 2;
          turn.agent_audio_wav_end_s = this.agentSamples / AGENT_SAMPLE_RATE;
        }
      }
    }

    if (sc?.inputTranscription?.text) {
      const cur = this.current;
      // the agent already answered and this is clearly new speech -> new turn
      if (cur && cur.agent_first_audio_ms != null && t - cur.agent_first_audio_ms > 1500) {
        this.closeTurn("user_spoke_again");
      }
      const turn = this.openTurn(t);
      turn.user_transcript += sc.inputTranscription.text;
      turn.user_transcript_first_ms ??= t;
      turn.user_transcript_last_ms = t;
    }

    if (sc?.outputTranscription?.text) {
      // The agent's words often arrive before its first audio chunk, so they
      // belong to the open turn. Only a late tail (no turn open, previous turn
      // closed moments ago) goes back to the previous turn.
      const prev = this.turns[this.turns.length - 1];
      const turn =
        this.current ??
        (prev && prev.closed_ms != null && t - prev.closed_ms < 1500 ? prev : this.openTurn(t));
      turn.agent_transcript += sc.outputTranscription.text;
    }

    if (sc?.interrupted) {
      const turn = this.lastAgentTurn();
      if (turn) turn.interrupted = true;
    }
    if (sc?.generationComplete) {
      const turn = this.lastAgentTurn();
      if (turn) turn.generation_complete_ms = t;
    }
    if (sc?.turnComplete) {
      if (this.current && this.current.agent_first_audio_ms != null) {
        this.current.turn_complete_ms = t;
        this.closeTurn(this.current.interrupted ? "interrupted" : "turn_complete");
      } else {
        const prev = this.lastAgentTurn();
        if (prev && prev.turn_complete_ms == null) prev.turn_complete_ms = t;
      }
    }

    // keep every message in the event log, minus the audio payload
    const slim = JSON.parse(
      JSON.stringify(m, (k, v) => (k === "data" && typeof v === "string" ? `<${v.length} b64 chars>` : v))
    );
    if (!(audioBytes && Object.keys(sc || {}).length === 1)) {
      this.events.push({ t_ms: t, type: "server", data: slim });
    }
    this.emit("update");
  }

  private onSent(chunks: Array<{ mimeType: string; data: string }>, t: number) {
    for (const ch of chunks) {
      if (ch.mimeType.includes("audio")) {
        const m = /rate=(\d+)/.exec(ch.mimeType);
        if (m) this.micRate = Number(m[1]);
        const bytes = b64ToBytes(ch.data);
        this.micChunks.push(bytes);
        this.micSamples += bytes.byteLength / 2;
        if (rms16(bytes) > STUDY_VAD_RMS_THRESHOLD) {
          this.lastSpeechMs = t;
          // only count speech toward the user's turn if the agent hasn't started answering
          const cur = this.current;
          if (!cur || cur.agent_first_audio_ms == null) {
            const turn = this.openTurn(t);
            turn.user_speech_start_ms ??= t;
          }
          this.speechActive = true;
        } else {
          this.speechActive = false;
        }
      } else if (ch.mimeType.includes("image")) {
        this.frameCounter += 1;
        const turn = this.current;
        this.frames.push({
          id: this.frameCounter,
          t_ms: t,
          turn_index: turn ? turn.turn_index : null,
          base64: ch.data,
        });
        if (turn) {
          turn.frames_sent += 1;
          turn.first_frame_id ??= this.frameCounter;
          turn.last_frame_id = this.frameCounter;
        }
        this.emit("update");
      }
    }
    this.exported = false;
  }

  /** seconds since the last camera frame was sent, or null if none yet */
  secondsSinceLastFrame(): number | null {
    const f = this.frames[this.frames.length - 1];
    return f ? Math.round((this.now() - f.t_ms) / 1000) : null;
  }

  get isSpeaking() {
    return this.speechActive;
  }

  allTurns(): Turn[] {
    return this.current ? [...this.turns, this.current] : [...this.turns];
  }

  micChunksForExport() {
    return this.micChunks;
  }
  agentChunksForExport() {
    return this.agentChunks;
  }
}
