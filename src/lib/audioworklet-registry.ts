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

/**
 * A registry to map attached worklets by their audio-context
 * any module using `audioContext.audioWorklet.addModule(` should register the worklet here
 */
export type WorkletGraph = {
  node?: AudioWorkletNode;
  handlers: Array<(this: MessagePort, ev: MessageEvent) => any>;
};

export const registeredWorklets: Map<
  AudioContext,
  Record<string, WorkletGraph>
> = new Map();

// Track which modules have already been loaded on each AudioContext
const loadedModules = new WeakMap<AudioContext, Set<string>>();

export const createWorketFromSrc = (
  workletName: string,
  workletSrc: string,
) => {
  const script = new Blob(
    [`registerProcessor("${workletName}", ${workletSrc})`],
    {
      type: "application/javascript",
    },
  );

  return URL.createObjectURL(script);
};

/**
 * Safely loads an audio worklet module onto an AudioContext without duplicate registration errors.
 */
export async function addWorkletModule(
  context: AudioContext,
  workletName: string,
  workletSrc: string,
): Promise<void> {
  let set = loadedModules.get(context);
  if (!set) {
    set = new Set<string>();
    loadedModules.set(context, set);
  }
  if (set.has(workletName)) {
    return;
  }
  const src = createWorketFromSrc(workletName, workletSrc);
  try {
    await context.audioWorklet.addModule(src);
    set.add(workletName);
  } catch (e: any) {
    // If the browser threw because it was already registered in this AudioWorkletGlobalScope, mark as loaded
    if (String(e?.message || e).includes("already been registered")) {
      set.add(workletName);
      return;
    }
    throw e;
  }
}
