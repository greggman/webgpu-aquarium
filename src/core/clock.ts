// Simulation clock. Real time normally; fully controllable for tests via
// ?time=, ?paused=1 and the dev hooks (setTime/step).

export class Clock {
  /** Simulated seconds. */
  time: number;
  /** Seconds advanced this frame. */
  dt = 0;
  paused: boolean;
  private last = -1;
  private pendingFrames = 0;
  private pendingDt = 0;
  private pendingResolve: (() => void) | null = null;

  constructor(startTime = 0, paused = false) {
    this.time = startTime;
    this.paused = paused;
  }

  /** Call once per animation frame with the rAF timestamp (ms). */
  tick(nowMs: number) {
    const real =
      this.last < 0 ? 1 / 60 : Math.min((nowMs - this.last) / 1000, 0.1);
    this.last = nowMs;
    if (this.pendingFrames > 0) {
      this.dt = this.pendingDt;
      this.pendingFrames--;
      if (this.pendingFrames === 0 && this.pendingResolve) {
        const r = this.pendingResolve;
        this.pendingResolve = null;
        // Resolve after this frame renders.
        requestAnimationFrame(() => r());
      }
    } else {
      this.dt = this.paused ? 0 : real;
    }
    this.time += this.dt;
  }

  setTime(t: number) {
    this.time = t;
  }

  /** Renders `frames` frames advancing `seconds` in total (works while paused). */
  step(seconds: number, frames: number): Promise<void> {
    this.pendingFrames = Math.max(1, frames);
    this.pendingDt = seconds / this.pendingFrames;
    return new Promise(r => (this.pendingResolve = r));
  }
}
