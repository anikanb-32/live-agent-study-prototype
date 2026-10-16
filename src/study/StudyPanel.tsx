import { memo, useEffect, useMemo, useReducer, useState } from "react";
import { Modality } from "@google/genai";
import { useLiveAPIContext } from "../contexts/LiveAPIContext";
import { SessionRecorder } from "./session-recorder";
import { saveSessionZip } from "./export-session";
import {
  STUDY_CONDITIONS,
  STUDY_DEFAULT_MODEL,
  STUDY_DEFAULT_VOICE,
  STUDY_SYSTEM_PROMPT,
  STUDY_TASKS,
} from "./study-config";
import "./study-panel.scss";

function StudyPanelComponent() {
  const { client, setConfig, setModel, model, connected } = useLiveAPIContext();
  const recorder = useMemo(() => new SessionRecorder(), []);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // study config: baseline prompt, audio out, transcripts on both sides, no tools
  useEffect(() => {
    setModel(STUDY_DEFAULT_MODEL);
    setConfig({
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: STUDY_DEFAULT_VOICE } },
      },
      systemInstruction: { parts: [{ text: STUDY_SYSTEM_PROMPT }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    });
  }, [setConfig, setModel]);

  useEffect(() => {
    recorder.attach(client);
    recorder.on("update", rerender);
    return () => {
      recorder.off("update", rerender);
    };
  }, [client, recorder]);

  // warn before losing an unexported session
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!recorder.exported && recorder.allTurns().length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [recorder]);

  // tick once a second so "last frame Ns ago" stays current
  useEffect(() => {
    const id = window.setInterval(rerender, 1000);
    return () => window.clearInterval(id);
  }, []);

  const turns = recorder.allTurns();
  const sinceFrame = recorder.secondsSinceLastFrame();
  const framesStalled = connected && sinceFrame != null && sinceFrame > 3;
  const last = [...turns].reverse().find((t) => t.latency_ms != null);
  const meta = recorder.meta;

  const doExport = async () => {
    setBusy(true);
    setStatus("Preparing export…");
    try {
      setStatus(await saveSessionZip(recorder));
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      rerender();
    }
  };

  const newSession = () => {
    if (!recorder.exported && turns.length && !window.confirm("This session hasn't been exported. Start a new one anyway?")) {
      return;
    }
    recorder.reset();
    setStatus("New session started");
  };

  return (
    <section className="study-panel" aria-label="Study session">
      <h1>Study session</h1>

      <div className="study-grid">
        <label>
          Participant
          <input
            value={meta.participant}
            onChange={(e) => recorder.setMeta({ participant: e.target.value })}
          />
        </label>
        <label>
          Task
          <select value={meta.task} onChange={(e) => recorder.setMeta({ task: e.target.value })}>
            {STUDY_TASKS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>
        <label>
          Condition
          <select value={meta.condition} onChange={(e) => recorder.setMeta({ condition: e.target.value })}>
            {STUDY_CONDITIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label>
          Trial
          <span className="row">
            <input
              type="number"
              min={1}
              value={meta.trial}
              onChange={(e) => recorder.setMeta({ trial: Number(e.target.value) || 1 })}
            />
            <button type="button" onClick={() => recorder.setMeta({ trial: meta.trial + 1 })}>
              Next trial
            </button>
          </span>
        </label>
        <label className="wide">
          Model {connected && <em>(disconnect to change)</em>}
          <input value={model} disabled={connected} onChange={(e) => setModel(e.target.value)} />
        </label>
      </div>

      <div className="row actions">
        <button type="button" onClick={() => recorder.marker("evidence in view")}>
          Mark: evidence in view
        </button>
        <button type="button" onClick={() => recorder.marker("scripted challenge")}>
          Mark: challenge
        </button>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          recorder.marker(`note: ${note.trim()}`);
          setNote("");
        }}
      >
        <label className="grow">
          <span className="sr-only">Note</span>
          <input placeholder="Quick note (saved with a timestamp)" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit">Add note</button>
      </form>

      <p className="stats">
        {connected ? "Connected" : "Not connected"} · {turns.length} turns · {recorder.frames.length} frames
        {sinceFrame != null && connected ? ` (last ${sinceFrame}s ago)` : ""}
        {last ? ` · last latency ${last.latency_ms} ms (${last.latency_source})` : ""}
      </p>

      {recorder.lastProblem && (
        <p className="warning" role="alert">{recorder.lastProblem}</p>
      )}

      {framesStalled && (
        <p className="warning" role="alert">
          Camera frames stopped {sinceFrame}s ago. Is the camera on, and is this tab in front?
        </p>
      )}

      <div className="row actions">
        <button type="button" className="primary" disabled={busy} onClick={doExport}>
          Export session
        </button>
        <button type="button" onClick={newSession}>New session</button>
      </div>
      <p className="status" role="status" aria-live="polite">{status}</p>

      <ol className="turns" aria-label="Turns">
        {turns.slice(-30).map((t) => (
          <li key={t.turn_index}>
            <div className="turn-head">
              #{t.turn_index} · {t.task} · trial {t.trial}
              {t.latency_ms != null && ` · ${t.latency_ms} ms`}
              {t.interrupted && " · interrupted"}
              {t.closed_ms == null && " · in progress"}
            </div>
            {t.user_transcript && <div className="user">You: {t.user_transcript}</div>}
            {t.agent_transcript && <div className="agent">Agent: {t.agent_transcript}</div>}
            {t.markers.length > 0 && <div className="marker">{t.markers.join(" · ")}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export const StudyPanel = memo(StudyPanelComponent);
