import { EventEmitter } from "eventemitter3";
import JSZip from "jszip";
import { SessionRecorder } from "./session-recorder";
import { buildSessionZip } from "./export-session";

// a stand-in for GenAILiveClient: same events, no network
class FakeClient extends EventEmitter {
  model = "models/test-live-model";
  getConfig() {
    return { systemInstruction: { parts: [{ text: "prompt" }] } };
  }
}

const pcm = (samples: number, amp: number) => {
  const b = new Uint8Array(samples * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < samples; i++) v.setInt16(i * 2, i % 2 ? amp : -amp, true);
  let s = "";
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s);
};

let clock = 0;
beforeEach(() => {
  clock = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => clock);
});

test("splits turns, measures latency, tracks frames, interruption and export", async () => {
  const client = new FakeClient();
  const rec = new SessionRecorder();
  rec.attach(client as any);
  rec.setMeta({ participant: "P01", task: "label", trial: 2 });
  client.emit("open");

  const send = (mime: string, data: string) => client.emit("realtimeinput", [{ mimeType: mime, data }], clock);
  const server = (sc: any) => client.emit("raw", { serverContent: sc }, clock);

  // turn 1: user speaks with camera on, agent answers
  clock = 1100; send("image/jpeg", btoa("frame1"));
  clock = 1200; send("audio/pcm;rate=16000", pcm(1600, 8000)); // loud = speech
  clock = 1900; send("audio/pcm;rate=16000", pcm(1600, 8000));
  clock = 2000; send("audio/pcm;rate=16000", pcm(1600, 10)); // quiet
  clock = 2100; server({ inputTranscription: { text: "Is it two capsules?" } });
  clock = 2150; send("image/jpeg", btoa("frame2"));
  clock = 2600; server({ modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm(2400, 500) } }] } });
  clock = 2700; server({ outputTranscription: { text: "The label says one capsule." } });
  clock = 3000; server({ generationComplete: true });
  clock = 3100; server({ turnComplete: true });

  expect(rec.turns).toHaveLength(1);
  const t1 = rec.turns[0];
  expect(t1.user_transcript).toBe("Is it two capsules?");
  expect(t1.agent_transcript).toBe("The label says one capsule.");
  expect(t1.latency_source).toBe("vad");
  expect(t1.latency_ms).toBe(2600 - 1900);
  expect(t1.frames_sent).toBe(1); // frame1 was sent before the turn opened
  expect(t1.frame_at_agent_start).toBe(2);
  expect(t1.task).toBe("label");
  expect(t1.trial).toBe(2);

  // turn 2: user barges in, server interrupts
  clock = 4000; server({ inputTranscription: { text: "Are you sure?" } });
  // the agent's words arrive before its first audio chunk (seen in a real session)
  clock = 4400; server({ outputTranscription: { text: "Yes, it" } });
  clock = 4500; server({ modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm(2400, 500) } }] } });
  clock = 4700; rec.marker("scripted challenge");
  clock = 4800; server({ interrupted: true });
  clock = 4810; server({ turnComplete: true });
  expect(rec.turns).toHaveLength(2);
  expect(rec.turns[1].interrupted).toBe(true);
  expect(rec.turns[0].agent_transcript).toBe("The label says one capsule.");
  expect(rec.turns[1].agent_transcript).toBe("Yes, it");
  expect(rec.turns[1].close_reason).toBe("interrupted");
  expect(rec.turns[1].latency_source).toBe("transcript");
  expect(rec.turns[1].markers[0]).toMatch(/scripted challenge/);

  const { blob, name } = await buildSessionZip(rec);
  expect(name).toMatch(/^P01_S\d/);
  const zip = await JSZip.loadAsync(blob);
  const files = Object.keys(zip.files);
  for (const f of ["session.json", "turns.csv", "turns.jsonl", "events.jsonl", "frames.csv", "user_audio.wav", "agent_audio.wav", "README.txt"]) {
    expect(files).toContain(f);
  }
  expect(files.filter((f) => f.startsWith("frames/") && f.endsWith(".jpg"))).toHaveLength(2);
  const session = JSON.parse(await zip.file("session.json")!.async("string"));
  expect(session.model).toBe("models/test-live-model");
  const csv = await zip.file("turns.csv")!.async("string");
  expect(csv.split("\n")[0]).toMatch(/^turn_index,.*,code,tone,evidence_new_this_turn,notes$/);
  const agentWav = await zip.file("agent_audio.wav")!.async("uint8array");
  expect(agentWav.byteLength).toBe(44 + 2 * 2400 * 2);
  // events never carry raw audio
  const events = await zip.file("events.jsonl")!.async("string");
  expect(events).not.toContain(pcm(2400, 500).slice(0, 40));
});
