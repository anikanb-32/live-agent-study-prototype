import JSZip from "jszip";
import { SessionRecorder, Turn } from "./session-recorder";
import { AGENT_SAMPLE_RATE, TURN_CODES } from "./study-config";

function wav(chunks: Uint8Array[], sampleRate: number): Blob {
  const dataLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  return new Blob([header, ...(chunks as BlobPart[])], { type: "audio/wav" });
}

function csvCell(x: unknown): string {
  if (x == null) return "";
  const s = Array.isArray(x) ? x.join(" | ") : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const TURN_COLUMNS: (keyof Turn)[] = [
  "turn_index", "participant", "task", "condition", "trial",
  "user_transcript", "agent_transcript",
  "latency_ms", "latency_source", "interrupted",
  "opened_ms", "user_speech_start_ms", "user_speech_end_ms",
  "user_transcript_first_ms", "user_transcript_last_ms",
  "agent_first_audio_ms", "agent_last_audio_ms",
  "generation_complete_ms", "turn_complete_ms", "closed_ms", "close_reason",
  "frames_sent", "first_frame_id", "last_frame_id", "frame_at_agent_start",
  "agent_audio_wav_start_s", "agent_audio_wav_end_s",
  "user_audio_wav_start_s", "user_audio_wav_end_s",
  "markers",
];
// empty columns for hand coding afterwards
const CODING_COLUMNS = ["code", "tone", "evidence_new_this_turn", "notes"];

const README = `Session export from the live-video sycophancy prototype.

session.json   model string, full Live config (incl. system prompt), session start time,
               user agent, summary counts.
turns.csv      one row per turn, ready for coding in a spreadsheet. Empty columns at the
               end: code (${TURN_CODES.join(" / ")}), tone (confident / neutral / hedged),
               evidence_new_this_turn, notes.
turns.jsonl    same turns as JSON lines.
events.jsonl   every server message (audio payloads stripped), connects, markers, notes,
               task/condition changes. Use this to rebuild turns if the automatic split is wrong.
frames.csv     every camera frame sent to the model: id, time, turn.
frames/        the JPEGs themselves, named <id>_<time ms>.jpg.
user_audio.wav mic audio as sent (16 kHz, or the phone's native rate; see session.json). Gaps while muted or disconnected are removed,
               so use user_audio_wav_start_s / _end_s in turns.csv to find a turn.
agent_audio.wav agent audio as RECEIVED (24 kHz), concatenated with silences removed.
               Not exactly what was heard: if the user interrupted, the tail was received
               but not played. Use agent_audio_wav_start_s / _end_s per turn.

Times are milliseconds since session start (see started_at in session.json).
latency_ms = first agent audio received minus the end of user speech. latency_source says
whether user speech end came from local mic voice activity ("vad", approximate) or the last
input-transcription chunk ("transcript", later than true speech end, so latency is understated).
It does not include the phone's playback buffering.
`;

export async function buildSessionZip(rec: SessionRecorder): Promise<{ blob: Blob; name: string }> {
  const zip = new JSZip();
  const turns = rec.allTurns();
  const name = `${rec.meta.participant || "P"}_${rec.sessionId}`;

  zip.file("README.txt", README);
  zip.file(
    "session.json",
    JSON.stringify(
      {
        session_id: rec.sessionId,
        started_at: rec.startedAtIso,
        exported_at: new Date().toISOString(),
        model: rec.model,
        config: rec.config,
        meta_at_export: rec.meta,
        user_agent: navigator.userAgent,
        counts: {
          turns: turns.length,
          frames: rec.frames.length,
          events: rec.events.length,
          user_audio_seconds: rec.micSamples / rec.micRate,
          user_audio_sample_rate: rec.micRate,
          agent_audio_seconds: rec.agentSamples / AGENT_SAMPLE_RATE,
        },
      },
      null,
      2
    )
  );
  zip.file("turns.jsonl", turns.map((t) => JSON.stringify(t)).join("\n"));
  zip.file(
    "turns.csv",
    [
      [...TURN_COLUMNS, ...CODING_COLUMNS].join(","),
      ...turns.map((t) => [...TURN_COLUMNS.map((c) => csvCell(t[c])), ...CODING_COLUMNS.map(() => "")].join(",")),
    ].join("\n")
  );
  zip.file("events.jsonl", rec.events.map((e) => JSON.stringify(e)).join("\n"));
  zip.file(
    "frames.csv",
    ["frame_id,t_ms,turn_index,file", ...rec.frames.map((f) => `${f.id},${f.t_ms},${f.turn_index ?? ""},frames/${f.id}_${f.t_ms}.jpg`)].join("\n")
  );
  const fdir = zip.folder("frames")!;
  rec.frames.forEach((f) => fdir.file(`${f.id}_${f.t_ms}.jpg`, f.base64, { base64: true }));
  zip.file("user_audio.wav", wav(rec.micChunksForExport(), rec.micRate));
  zip.file("agent_audio.wav", wav(rec.agentChunksForExport(), AGENT_SAMPLE_RATE));

  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, name: `${name}.zip` };
}

/** On phones, open the share sheet (Save to Files, AirDrop, Drive...). Otherwise download. */
export async function saveSessionZip(rec: SessionRecorder): Promise<string> {
  const { blob, name } = await buildSessionZip(rec);
  const file = new File([blob], name, { type: "application/zip" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      rec.exported = true;
      return `Shared ${name}`;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return "Share cancelled";
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  rec.exported = true;
  return `Downloaded ${name}`;
}
