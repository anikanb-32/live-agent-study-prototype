/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type GetAudioContextOptions = AudioContextOptions & {
  id?: string;
};

const map: Map<string, AudioContext> = new Map();

function createAudioContextInstance(options?: GetAudioContextOptions): AudioContext {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio API not supported on this browser");
  }

  const { id, ...contextOptions } = options || {};

  // Try creating with specific options (e.g. sampleRate: 16000 on desktop Chrome)
  if (contextOptions.sampleRate) {
    try {
      return new AudioCtx(contextOptions);
    } catch (e) {
      // iOS Safari throws NotSupportedError when sampleRate is outside [44100, 96000]
      console.warn(
        `AudioContext with sampleRate ${contextOptions.sampleRate} rejected, using native hardware rate`,
        e
      );
    }
  }

  // Fallback to native hardware rate (guaranteed to work across mobile and desktop)
  return new AudioCtx();
}

function getOrCreateContext(id?: string, options?: GetAudioContextOptions): AudioContext {
  if (id && map.has(id)) {
    return map.get(id)!;
  }
  const ctx = createAudioContextInstance(options);
  if (id) {
    map.set(id, ctx);
  }
  return ctx;
}

export const audioContext = async (
  options?: GetAudioContextOptions
): Promise<AudioContext> => {
  const ctx = getOrCreateContext(options?.id, options);
  if (ctx.state !== "running") {
    await ctx.resume().catch(() => {});
  }
  return ctx;
};

export function base64ToArrayBuffer(base64: string) {
  var binaryString = atob(base64);
  var bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * [study] Mobile browsers (especially iOS Safari) start Web Audio suspended
 * and strictly require a user gesture (tap/click) to resume or create audio contexts.
 * Pre-instantiate both contexts and resume them synchronously within the tap handler.
 */
export function unlockAudio() {
  if (!map.has("audio-out")) {
    try {
      getOrCreateContext("audio-out");
    } catch (e) {}
  }
  if (!map.has("audio-in")) {
    try {
      getOrCreateContext("audio-in", { sampleRate: 16000 });
    } catch (e) {}
  }

  map.forEach((ctx) => {
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }
  });
}

// Automatically hook early touch and pointer events to unlock audio as soon as the user taps
if (typeof window !== "undefined") {
  const unlockEvents = ["pointerdown", "touchstart", "click"];
  const handleInteraction = () => {
    unlockAudio();
  };
  unlockEvents.forEach((evt) => {
    window.addEventListener(evt, handleInteraction, { capture: true, passive: true });
  });
}
