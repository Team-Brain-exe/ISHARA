import type { Frame } from "./dtw";
export interface SegmenterOptions { startEnergyThreshold?: number; endEnergyThreshold?: number; stillFramesToEnd?: number; preRollFrames?: number; maxFrames?: number; }
export class Segmenter {
  private opts: Required<SegmenterOptions>;
  private preRoll: Frame[] = []; private buffer: Frame[] = []; private active = false; private stillCount = 0; private prevFrame: Frame | null = null;
  constructor(private onStart: () => void, private onComplete: (frames: Frame[]) => void, opts: SegmenterOptions = {}) {
    this.opts = { startEnergyThreshold: opts.startEnergyThreshold ?? 0.02, endEnergyThreshold: opts.endEnergyThreshold ?? 0.008, stillFramesToEnd: opts.stillFramesToEnd ?? 6, preRollFrames: opts.preRollFrames ?? 4, maxFrames: opts.maxFrames ?? 150 };
  }
  private energy(a: Frame, b: Frame): number { let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2; return sum / a.length; }
  reset() { this.preRoll = []; this.buffer = []; this.active = false; this.stillCount = 0; this.prevFrame = null; }
  push(frame: Frame | null) {
    if (!frame) { if (this.active) this.handleStillFrame(); this.prevFrame = null; return; }
    const e = this.prevFrame ? this.energy(frame, this.prevFrame) : 0;
    this.prevFrame = frame;
    if (!this.active) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.opts.preRollFrames) this.preRoll.shift();
      if (e >= this.opts.startEnergyThreshold) { this.active = true; this.stillCount = 0; this.buffer = [...this.preRoll, frame]; this.onStart(); }
      return;
    }
    this.buffer.push(frame);
    if (e < this.opts.endEnergyThreshold) { this.stillCount++; if (this.stillCount >= this.opts.stillFramesToEnd) { this.finish(); return; } }
    else this.stillCount = 0;
    if (this.buffer.length >= this.opts.maxFrames) this.finish();
  }
  private handleStillFrame() { this.stillCount++; if (this.stillCount >= this.opts.stillFramesToEnd) this.finish(); }
  private finish() { const frames = this.buffer; this.reset(); this.onComplete(frames); }
}
