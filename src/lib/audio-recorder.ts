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

import { audioContext } from "./utils";
import AudioRecordingWorklet from "./worklets/audio-processing";
import VolMeterWorket from "./worklets/vol-meter";

import { addWorkletModule } from "./audioworklet-registry";
import EventEmitter from "eventemitter3";

function arrayBufferToBase64(buffer: ArrayBuffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export class AudioRecorder extends EventEmitter {
  stream: MediaStream | undefined;
  audioContext: AudioContext | undefined;
  source: MediaStreamAudioSourceNode | undefined;
  recording: boolean = false;
  recordingWorklet: AudioWorkletNode | undefined;
  vuWorklet: AudioWorkletNode | undefined;
  muteGain: GainNode | undefined;

  // Output sample rate sent to Gemini Live API is ALWAYS 16000 Hz,
  // because AudioProcessingWorklet resamples native rates (44.1k/48k) to 16k.
  public readonly sampleRate = 16000;

  private starting: Promise<void> | null = null;

  async start() {
    if (this.recording) return;
    if (this.starting) return this.starting;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error("Could not request user media (getUserMedia not supported)");
      this.emit("error", err);
      throw err;
    }

    this.starting = new Promise<void>(async (resolve, reject) => {
      try {
        // Request mic stream with mobile-optimized constraints
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
        } catch (constraintErr) {
          // Fallback if specific audio constraints are rejected
          this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }

        this.audioContext = await audioContext({ id: "audio-in", sampleRate: 16000 });
        if (this.audioContext.state !== "running") {
          await this.audioContext.resume().catch(() => {});
        }

        this.source = this.audioContext.createMediaStreamSource(this.stream);

        // Load recorder worklet safely without duplicate registration issues
        const workletName = "audio-recorder-worklet";
        await addWorkletModule(this.audioContext, workletName, AudioRecordingWorklet);

        this.recordingWorklet = new AudioWorkletNode(
          this.audioContext,
          workletName,
        );

        this.recordingWorklet.port.onmessage = (ev: MessageEvent) => {
          const arrayBuffer = ev.data?.data?.int16arrayBuffer;
          if (arrayBuffer) {
            const arrayBufferString = arrayBufferToBase64(arrayBuffer);
            this.emit("data", arrayBufferString);
          }
        };
        this.source.connect(this.recordingWorklet);

        // WebKit / iOS Safari pull architecture:
        // In Safari, if an AudioWorkletNode's output does not connect to destination,
        // WebKit does not pull samples and process() is never executed.
        // Connecting through a mute gain node (gain=0) to destination keeps Safari actively
        // pulling mic samples without playing mic feedback out of the phone speakers.
        this.muteGain = this.audioContext.createGain();
        this.muteGain.gain.value = 0;
        this.recordingWorklet.connect(this.muteGain);
        this.muteGain.connect(this.audioContext.destination);

        // Load VU meter worklet
        const vuWorkletName = "vu-meter";
        await addWorkletModule(this.audioContext, vuWorkletName, VolMeterWorket);
        this.vuWorklet = new AudioWorkletNode(this.audioContext, vuWorkletName);
        this.vuWorklet.port.onmessage = (ev: MessageEvent) => {
          this.emit("volume", ev.data?.volume || 0);
        };

        this.source.connect(this.vuWorklet);
        this.vuWorklet.connect(this.muteGain);

        this.recording = true;
        this.emit("started", this.sampleRate);
        resolve();
      } catch (e) {
        this.emit("error", e);
        reject(e);
      } finally {
        this.starting = null;
      }
    });

    return this.starting.catch(() => {});
  }

  stop() {
    const handleStop = () => {
      this.recording = false;
      try {
        this.source?.disconnect();
      } catch (e) {}
      try {
        this.recordingWorklet?.disconnect();
      } catch (e) {}
      try {
        this.vuWorklet?.disconnect();
      } catch (e) {}
      try {
        this.muteGain?.disconnect();
      } catch (e) {}

      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = undefined;
      this.source = undefined;
      this.recordingWorklet = undefined;
      this.vuWorklet = undefined;
      this.muteGain = undefined;
    };

    if (this.starting) {
      this.starting.then(handleStop).catch(handleStop);
      return;
    }
    handleStop();
  }
}
