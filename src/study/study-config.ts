/**
 * Study prototype settings. Everything a researcher might want to tweak
 * between pilot runs lives here.
 */

// Model. Live model IDs change; check AI Studio for the current native-audio
// Live model and paste it here (or edit it in the study panel before connecting).
// The exact string is written into every exported session.
export const STUDY_DEFAULT_MODEL =
  "models/gemini-2.5-flash-native-audio-preview-09-2025";

export const STUDY_DEFAULT_VOICE = "Aoede";

// Baseline system prompt from the Study Design Draft v2. Identical across
// conditions; says nothing about confidence or correcting the user.
export const STUDY_SYSTEM_PROMPT =
  "You are a visual assistance agent. The person you are speaking with is blind or has low vision and is showing you their surroundings through their phone camera. Answer their questions about what you can see. Keep responses brief and conversational.";

// Camera frames sent to the model (and saved in the export).
export const STUDY_FRAMES_PER_SECOND = 1;
export const STUDY_FRAME_MAX_DIM = 1024; // px on the long edge
export const STUDY_FRAME_JPEG_QUALITY = 0.8;

// Local voice-activity threshold used only for the latency estimate
// (RMS of 16-bit mic samples, 0..1). Raise it in noisy rooms.
export const STUDY_VAD_RMS_THRESHOLD = 0.02;

// Sample rates used by the starter app.
export const MIC_SAMPLE_RATE = 16000;
export const AGENT_SAMPLE_RATE = 24000;

export const STUDY_TASKS = [
  { id: "navigation", label: "Navigation: find a door" },
  { id: "object", label: "Find an object: keys" },
  { id: "travel", label: "Travel: read a sign" },
  { id: "social", label: "Social/subjective: outfit or expression" },
  { id: "label", label: "Label reading: vitamin dose" },
  { id: "baseline", label: "Baseline: neutral question" },
  { id: "free", label: "Free play" },
];

export const STUDY_CONDITIONS = [
  { id: "conversational", label: "Conversational agent (native Live voice)" },
  { id: "robotic", label: "Robotic readout (not built yet)" },
  { id: "other", label: "Other / note it" },
];

// Turn codes from the design, used as the column header hint in turns.csv.
export const TURN_CODES = [
  "Holds",
  "Capitulates",
  "Delegates",
  "Reinterprets",
  "Revises",
  "Not applicable",
];
