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

const AudioRecordingWorklet = `
class AudioProcessingWorklet extends AudioWorkletProcessor {
  // send and clear buffer every 2048 samples at 16 kHz (~8 times a second)
  buffer = new Int16Array(2048);
  bufferWriteIndex = 0;

  targetRate = 16000;
  sourcePos = 0;
  prevSample = 0;
  hasPrev = false;

  constructor() {
    super();
    this.isDirect = sampleRate === this.targetRate;
    this.step = sampleRate / this.targetRate;
  }

  /**
   * @param inputs Float32Array[][] [input#][channel#][sample#]
   * @param outputs Float32Array[][]
   */
  process(inputs) {
    if (inputs[0] && inputs[0].length > 0) {
      const channel0 = inputs[0][0];
      if (channel0 && channel0.length > 0) {
        this.processChunk(channel0);
      }
    }
    return true;
  }

  sendAndClearBuffer() {
    this.port.postMessage({
      event: "chunk",
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
      },
    });
    this.bufferWriteIndex = 0;
  }

  pushSample(val) {
    // clamp to [-1.0, 1.0] and convert to 16-bit PCM
    const clamped = Math.max(-1, Math.min(1, val));
    const int16Value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    this.buffer[this.bufferWriteIndex++] = int16Value;
    if (this.bufferWriteIndex >= this.buffer.length) {
      this.sendAndClearBuffer();
    }
  }

  processChunk(float32Array) {
    const len = float32Array.length;

    if (this.isDirect) {
      for (let i = 0; i < len; i++) {
        this.pushSample(float32Array[i]);
      }
      return;
    }

    // Resample from hardware sampleRate (e.g. 44.1 kHz or 48 kHz on mobile phones)
    // down to 16 kHz using linear interpolation
    const step = this.step;
    while (this.sourcePos < len) {
      const i0 = Math.floor(this.sourcePos);
      const frac = this.sourcePos - i0;
      const s0 = i0 === 0 && this.hasPrev ? this.prevSample : float32Array[i0];
      const s1 = (i0 + 1 < len) ? float32Array[i0 + 1] : float32Array[len - 1];
      const interpolated = s0 + frac * (s1 - s0);
      this.pushSample(interpolated);
      this.sourcePos += step;
    }

    this.sourcePos -= len;
    this.prevSample = float32Array[len - 1];
    this.hasPrev = true;
  }
}
`;

export default AudioRecordingWorklet;
