// GPU profiler (?profile=gpu): times every render and compute pass with
// timestamp queries and counts the triangles each pass draws, without the
// individual systems knowing about it. Results are averaged and exposed on
// window.__aquarium.gpuProfile.
//
// Caveat: tile-based GPUs (Apple) defer rendering to the end of the command
// buffer, so each pass's timestamps span most of the frame and per-pass times
// can't be compared there. Triangle and draw counts are always exact.

export interface PassStats {
  /** Average GPU milliseconds per frame. */
  ms: number;
  /** Average triangles submitted per frame. */
  triangles: number;
  /** Average draw calls per frame. */
  draws: number;
}

type AnyFn = (...args: unknown[]) => unknown;

const MAX_QUERIES = 128;

export class GpuProfiler {
  readonly stats = new Map<string, PassStats>();
  private device: GPUDevice;
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private staging: GPUBuffer[] = [];
  private next = 0;
  private labels: string[] = [];
  private frameTris = new Map<string, {triangles: number; draws: number}>();

  static install(device: GPUDevice): GpuProfiler | null {
    if (!device.features.has('timestamp-query')) {
      console.warn('[profiler] timestamp-query is not available');
      return null;
    }
    return new GpuProfiler(device);
  }

  private constructor(device: GPUDevice) {
    this.device = device;
    this.querySet = device.createQuerySet({
      label: 'profiler:query-set',
      type: 'timestamp',
      count: MAX_QUERIES,
    });
    this.resolveBuffer = device.createBuffer({
      label: 'profiler:resolve',
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.wrap();
  }

  private wrap() {
    const device = this.device;
    const origEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (desc?: GPUCommandEncoderDescriptor) => {
      const encoder = origEncoder(desc);
      const enc = encoder as unknown as Record<string, AnyFn>;
      let first = -1;
      let last = -1;
      const timed = (name: 'beginRenderPass' | 'beginComputePass') => {
        const orig = enc[name].bind(encoder);
        enc[name] = (d?: unknown) => {
          const passDesc = (d ?? {}) as GPURenderPassDescriptor &
            GPUComputePassDescriptor;
          const label = passDesc.label ?? name;
          if (this.next + 2 <= MAX_QUERIES && !passDesc.timestampWrites) {
            const i = this.next;
            this.next += 2;
            this.labels[i] = label;
            first = first < 0 ? i : first;
            last = i + 2;
            passDesc.timestampWrites = {
              querySet: this.querySet,
              beginningOfPassWriteIndex: i,
              endOfPassWriteIndex: i + 1,
            };
          }
          const pass = orig(passDesc) as Record<string, AnyFn>;
          if (name === 'beginRenderPass') {
            this.countDraws(pass, label);
          }
          return pass;
        };
      };
      timed('beginRenderPass');
      timed('beginComputePass');
      const origFinish = enc.finish.bind(encoder);
      enc.finish = (d?: unknown) => {
        if (first >= 0) {
          // Resolve everything written so far this frame (query values persist,
          // and resolve offsets must be multiples of 256, so always from 0).
          encoder.resolveQuerySet(
            this.querySet,
            0,
            last,
            this.resolveBuffer,
            0,
          );
        }
        return origFinish(d);
      };
      return encoder;
    };
  }

  private countDraws(pass: Record<string, AnyFn>, label: string) {
    // Draws are attributed to the innermost debug group (the system name).
    let group = '';
    const push = pass.pushDebugGroup.bind(pass);
    pass.pushDebugGroup = (...args: unknown[]) => {
      group = args[0] as string;
      return push(...args);
    };
    const pop = pass.popDebugGroup.bind(pass);
    pass.popDebugGroup = (...args: unknown[]) => {
      group = '';
      return pop(...args);
    };
    const add = (verts: number, instances: number) => {
      const key = group ? `${label} › ${group}` : label;
      const t = this.frameTris.get(key) ?? {triangles: 0, draws: 0};
      t.triangles += (verts / 3) * instances;
      t.draws += 1;
      this.frameTris.set(key, t);
    };
    const drawIndexed = pass.drawIndexed.bind(pass);
    pass.drawIndexed = (...args: unknown[]) => {
      add(args[0] as number, (args[1] as number | undefined) ?? 1);
      return drawIndexed(...args);
    };
    const draw = pass.draw.bind(pass);
    pass.draw = (...args: unknown[]) => {
      add(args[0] as number, (args[1] as number | undefined) ?? 1);
      return draw(...args);
    };
  }

  private frames = 0;
  /** Smoothed GPU time from the first pass start to the last pass end. */
  frameMs = 0;

  /** Call once per frame after the frame's command buffers are submitted. */
  endFrame() {
    // Skip the first frames: they include one-off generation passes.
    if (this.frames++ < 3) {
      this.next = 0;
      this.frameTris.clear();
      return;
    }
    const count = this.next;
    const labels = this.labels.slice(0, count);
    const tris = new Map(this.frameTris);
    this.next = 0;
    this.frameTris.clear();
    if (count === 0) {
      return;
    }
    const staging =
      this.staging.pop() ??
      this.device.createBuffer({
        label: 'profiler:staging',
        size: MAX_QUERIES * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    const encoder = this.device.createCommandEncoder({
      label: 'profiler:copy-encoder',
    });
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, staging, 0, count * 8);
    this.device.queue.submit([encoder.finish({label: 'profiler:copy'})]);
    void staging.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
      const times = new BigInt64Array(staging.getMappedRange(0, count * 8));
      const frame = new Map<string, number>();
      // Whole-frame GPU span: first pass start to last pass end. Unlike the
      // per-pass numbers this is meaningful on tile-based GPUs too.
      let first = Infinity;
      let last = -Infinity;
      for (let i = 0; i < count; i += 2) {
        if (times[i + 1] > times[i]) {
          first = Math.min(first, Number(times[i]));
          last = Math.max(last, Number(times[i + 1]));
        }
      }
      if (last > first) {
        this.frameMs += ((last - first) / 1e6 - this.frameMs) * 0.1;
      }
      for (let i = 0; i < count; i += 2) {
        const ns = Number(times[i + 1] - times[i]);
        if (ns >= 0 && ns < 1e9) {
          frame.set(labels[i], (frame.get(labels[i]) ?? 0) + ns / 1e6);
        }
      }
      staging.unmap();
      this.staging.push(staging);
      const keys = new Set([...frame.keys(), ...tris.keys()]);
      for (const k of keys) {
        const s = this.stats.get(k) ?? {ms: 0, triangles: 0, draws: 0};
        const t = tris.get(k);
        const a = 0.1;
        s.ms += ((frame.get(k) ?? 0) - s.ms) * a;
        s.triangles += ((t?.triangles ?? 0) - s.triangles) * a;
        s.draws += ((t?.draws ?? 0) - s.draws) * a;
        this.stats.set(k, s);
      }
    });
  }

  /** A readable table, most expensive first. */
  summary(): string {
    const rows = [...this.stats.entries()]
      .filter(([, s]) => s.ms > 0.005 || s.draws > 0.5)
      .sort((a, b) => b[1].ms - a[1].ms);
    const total = rows.reduce((n, [, s]) => n + s.ms, 0);
    return [
      `gpu frame span: ${this.frameMs.toFixed(1)} ms (sum of passes ${total.toFixed(1)} ms)`,
      ...rows.map(
        ([k, s]) =>
          `${s.ms.toFixed(2).padStart(6)} ms  ${(s.triangles / 1e3).toFixed(0).padStart(6)}k tris ${s.draws.toFixed(0).padStart(4)} draws  ${k}`,
      ),
    ].join('\n');
  }
}
