// Creature-following auto camera: swims alongside one animal (a fish, a
// school's leader, a ray or a jellyfish), keeping it framed, and every 10-15
// seconds picks another one nearby and glides over to it. Changing subject is
// a crossfade: both animals are tracked while the camera's position and aim
// blend from one to the other over a few seconds, and the camera turns like
// an operator would (eased, rate-limited), so it never snaps.
//
// Fish positions live on the GPU. They are read back asynchronously and never
// waited on: the frame loop keeps using the most recent answer, extrapolated
// by the subject's measured velocity, until a newer one arrives.

import * as vec3 from '../math/vec3.ts';
import type {Vec3} from '../math/vec3.ts';
import type {Rng} from '../core/rng.ts';
import {anglesFromDirection, type CameraPose} from './camera.ts';
import type {NavVolume} from './navvolume.ts';
import type {FishSystem, FollowCandidate} from '../sim/fish.ts';
import type {JellyfishSystem} from '../sim/jellyfish.ts';

interface Subject {
  kind: 'fish' | 'jelly';
  index: number;
  species: string;
  /** Distance the camera keeps from it. */
  distance: number;
}

/** A position sample with the time (camera clock) it was taken. */
interface Sample {
  pos: Vec3;
  fwd: Vec3;
  time: number;
}

/** Subjects to follow before a jellyfish becomes eligible. */
const JELLY_AFTER = 5;

/** How much the camera likes following each kind of animal. */
const INTEREST: Record<string, number> = {
  manta: 3,
  'eagle-ray': 2.6,
  grouper: 2.2,
  curious: 2,
  bait: 2,
  parrot: 1.8,
  tang: 1.5,
  kelpfish: 1.4,
  butterfly: 1.3,
  wrasse: 1.1,
  damsel: 1,
  clown: 0.5,
  chromis: 0.8,
  anthias: 0.8,
  jelly: 1.1,
};

/** Follows one subject: its latest position sample and a velocity estimate. */
class Tracker {
  readonly subject: Subject;
  sample: Sample | null = null;
  private prev: Sample | null = null;
  vel: Vec3 = [0, 0, 0];
  pending = false;
  lost = false;
  /** Which side of the subject the camera sits on (chosen on first sight). */
  side = 0;
  /** How far back this shot sits: 1 is close, larger pulls out. */
  shot = 1;
  /** Smoothed heading of the subject. */
  heading: Vec3 = [0, 0, 1];

  constructor(subject: Subject) {
    this.subject = subject;
  }

  accept(pos: Vec3, fwd: Vec3, time: number) {
    this.prev = this.sample;
    if (!this.sample) {
      this.heading = vec3.normalize([fwd[0], fwd[1] * 0.3, fwd[2]]);
    }
    this.sample = {pos, fwd, time};
    const prev = this.prev;
    if (prev && time > prev.time + 1e-3) {
      const v = vec3.scale(vec3.sub(pos, prev.pos), 1 / (time - prev.time));
      // Low-pass: readback timing jitters.
      this.vel = vec3.add(vec3.scale(this.vel, 0.6), vec3.scale(v, 0.4));
    }
  }

  /** Position now: the last sample moved along by its velocity. */
  estimate(time: number): Vec3 | null {
    if (!this.sample) {
      return null;
    }
    const age = Math.min(time - this.sample.time, 0.5);
    return vec3.add(this.sample.pos, vec3.scale(this.vel, age));
  }

  updateHeading(dt: number) {
    if (!this.sample) {
      return;
    }
    const f = this.sample.fwd;
    const k = 1 - Math.exp(-dt * 0.8);
    this.heading = vec3.normalize(
      vec3.add(
        vec3.scale(this.heading, 1 - k),
        vec3.scale([f[0], f[1] * 0.3, f[2]], k),
      ),
    );
  }
}

const smoothstep = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export class CreatureCam {
  private nav: NavVolume;
  private fish: FishSystem;
  private jellyfish: JellyfishSystem;
  private rng: Rng;

  private time = 0;
  private pos: Vec3 = [0, 0, 0];
  private vel: Vec3 = [0, 0, 0];
  /** Point the camera aims at (smoothed). */
  private look: Vec3 = [0, 0, 1];
  private yaw = 0;
  private pitch = 0;
  private yawRate = 0;
  private pitchRate = 0;
  /** Subject being followed, and the one being left during a transition. */
  private current: Tracker | null = null;
  private previous: Tracker | null = null;
  /** Time the current subject was first seen (transition start). */
  private blendStart = 0;
  private readonly blendTime = 4.5;
  private switchAt = 0;
  private orbitPhase = 0;
  private scanPending = false;
  private nextScan = 0;
  /** Recently scanned candidate positions. */
  private scanned: {c: FollowCandidate; pos: Vec3}[] = [];
  private generation = 0;
  /** Subjects chosen so far, and consecutive picks that found nothing. */
  private picks = 0;
  private empty = 0;

  constructor(
    nav: NavVolume,
    fish: FishSystem,
    jellyfish: JellyfishSystem,
    rng: Rng,
  ) {
    this.nav = nav;
    this.fish = fish;
    this.jellyfish = jellyfish;
    this.rng = rng;
  }

  /** What is being followed, for debugging (e.g. "bait #1234"). */
  get subjectName(): string {
    const s = this.current?.subject;
    return s ? `${s.species} #${s.index}` : '';
  }

  /** True once there is something to follow (until then use another camera). */
  get ready(): boolean {
    return !!this.current?.sample;
  }

  /** Moves the camera to a pose without restarting the search for a subject. */
  syncPose(pose: CameraPose) {
    this.pos = vec3.clone(pose.pos);
    this.vel = [0, 0, 0];
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    this.yawRate = 0;
    this.pitchRate = 0;
    const f: Vec3 = [
      -Math.sin(pose.yaw) * Math.cos(pose.pitch),
      Math.sin(pose.pitch),
      -Math.cos(pose.yaw) * Math.cos(pose.pitch),
    ];
    this.look = vec3.add(pose.pos, vec3.scale(f, 4));
  }

  /** Starts following from the given pose (e.g. where the user left off). */
  begin(pose: CameraPose) {
    this.syncPose(pose);
    this.current = null;
    this.previous = null;
    this.scanned = [];
    this.nextScan = 0;
    this.switchAt = 0;
    this.picks = 0;
    this.empty = 0;
    this.generation++;
  }

  update(dt: number): CameraPose {
    this.time += dt;
    this.scan();
    if (!this.current || this.current.lost || this.time >= this.switchAt) {
      this.pickSubject();
    }
    this.refresh(this.current);
    this.refresh(this.previous);
    this.orbitPhase += dt * 0.08;
    this.current?.updateHeading(dt);
    this.previous?.updateHeading(dt);

    const framing = this.framing();
    if (framing) {
      // Chase a spot that keeps its own clearance, not the raw spot beside the
      // animal: see clearSpot. The aim is unaffected, so the shot still holds
      // the animal while the camera flies around whatever is in the way.
      const spot = this.clearSpot(framing.cameraAt);
      // Critically damped spring toward the desired spot, speed-limited so
      // moving between subjects is a glide.
      const omega = 1.0;
      for (let i = 0; i < 3; i++) {
        const x = this.pos[i] - spot[i];
        this.vel[i] += (-omega * omega * x - 2 * omega * this.vel[i]) * dt;
      }
      const speed = vec3.length(this.vel);
      const maxSpeed = 2.6;
      if (speed > maxSpeed) {
        this.vel = vec3.scale(this.vel, maxSpeed / speed);
      }
      this.pos = vec3.add(this.pos, vec3.scale(this.vel, dt));
      this.nav.constrain(this.pos, this.vel, dt);
      const la = 1 - Math.exp(-dt * 1.6);
      this.look = vec3.add(
        vec3.scale(this.look, 1 - la),
        vec3.scale(framing.aim, la),
      );
    }

    // Turn toward the aim point like a camera operator: accelerate and
    // decelerate smoothly, and never faster than a gentle maximum rate.
    const dir = vec3.sub(this.look, this.pos);
    const want = anglesFromDirection(
      vec3.length(dir) > 1e-3 ? dir : [0, 0, -1],
    );
    const wantPitch = Math.max(-1.1, Math.min(1.1, want.pitch));
    const turn = (angle: number, rate: number, target: number) => {
      const err = wrapAngle(target - angle);
      const omega = 2.2;
      let r = rate + (err * omega * omega - 2 * omega * rate) * dt;
      const maxRate = 0.7;
      r = Math.max(-maxRate, Math.min(maxRate, r));
      return [angle + r * dt, r];
    };
    [this.yaw, this.yawRate] = turn(this.yaw, this.yawRate, want.yaw);
    [this.pitch, this.pitchRate] = turn(this.pitch, this.pitchRate, wantPitch);
    this.yaw = wrapAngle(this.yaw);
    // A touch of banking into turns.
    const roll = Math.max(-0.08, Math.min(0.08, -this.yawRate * 0.12));
    return {pos: vec3.clone(this.pos), yaw: this.yaw, pitch: this.pitch, roll};
  }

  /**
   * Where the camera wants to be and look, blending from the previous subject
   * to the current one over a few seconds once the new one has been seen.
   */
  /**
   * The nearest place to `want` that the camera can actually be.
   *
   * Flying straight at the spot beside an animal means flying into whatever
   * stands between: the nav volume then shoves the camera back out, and the
   * shot jolts. Giving the *target* the clearance instead — lifted off the
   * ground, out of the rocks, and raised until the way there is clear — leaves
   * the camera with nothing to be pushed out of, so it arcs over the reef
   * rather than bumping along it. What it looks at never moves.
   */
  private clearSpot(want: Readonly<Vec3>): Vec3 {
    const margin = 0.9;
    const out: Vec3 = [want[0], want[1], want[2]];
    const floorAt = (x: number, z: number) => this.nav.floorAt(x, z) + margin;
    out[1] = Math.max(out[1], floorAt(out[0], out[2]));

    // Raise it until the straight line from here clears the ground: a rise at
    // fraction t of the way needs the far end lifted by deficit / t.
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = this.pos[0] + (out[0] - this.pos[0]) * t;
      const z = this.pos[2] + (out[2] - this.pos[2]) * t;
      const y = this.pos[1] + (out[1] - this.pos[1]) * t;
      const deficit = floorAt(x, z) - y;
      if (deficit > 0) {
        out[1] += deficit / t;
      }
    }

    // Out of the rocks, twice, since pushing clear of one can bury it in
    // another.
    for (let pass = 0; pass < 2; pass++) {
      for (const o of this.nav.o.obstacles ?? []) {
        const dx = out[0] - o.center[0];
        const dy = out[1] - o.center[1];
        const dz = out[2] - o.center[2];
        const d = Math.hypot(dx, dy, dz);
        const r = o.radius + margin;
        if (d < r && d > 1e-3) {
          const k = (r - d) / d;
          out[0] += dx * k;
          out[1] += dy * k;
          out[2] += dz * k;
        }
      }
      out[1] = Math.max(out[1], floorAt(out[0], out[2]));
    }
    out[1] = Math.min(out[1], this.nav.ceiling() - 0.3);
    return out;
  }

  private framing(): {cameraAt: Vec3; aim: Vec3} | null {
    const one = (t: Tracker) => {
      const p = t.estimate(this.time);
      if (!p) {
        return null;
      }
      const fwd = t.heading;
      const right = vec3.normalize(vec3.cross([0, 1, 0], fwd));
      if (t.side === 0) {
        // Pick the side with something behind the animal: shooting across a
        // canyon or out into open water gives the frame depth, where shooting
        // into the rise behind it gives a wall of sand a metre from the lens.
        const depthBehind = (side: number) => {
          const a0 = side * 0.9;
          const back = vec3.add(
            vec3.scale(fwd, -Math.cos(a0)),
            vec3.scale(right, Math.sin(a0)),
          );
          // How far the ground falls away on the far side of the animal.
          let fall = 0;
          for (const d of [8, 16, 26]) {
            const x = p[0] - back[0] * d;
            const z = p[2] - back[2] * d;
            fall += p[1] - this.nav.floorAt(x, z);
          }
          return fall;
        };
        const left = depthBehind(1);
        const rightward = depthBehind(-1);
        t.side =
          Math.abs(left - rightward) < 1
            ? vec3.dot(vec3.sub(this.pos, p), right) >= 0
              ? 1
              : -1
            : left > rightward
              ? 1
              : -1;
      }
      const d = t.subject.distance * t.shot;
      // (floorAt already includes the camera's clearance above the ground.)
      const nearBottom = p[1] - this.nav.floorAt(p[0], p[2]) < 1.2;
      const angle = t.side * (0.9 + Math.sin(this.orbitPhase) * 0.5);
      const offset = vec3.add(
        vec3.add(
          vec3.scale(fwd, -Math.cos(angle) * d),
          vec3.scale(right, Math.sin(angle) * d),
        ),
        // Only a little above: enough to see over the coral in front, not so
        // much that the shot becomes a map of the sand. Looking along the
        // seabed is what puts the reef, the walls and the open water in frame.
        [0, d * (nearBottom ? 0.32 : 0.12), 0],
      );
      return {
        cameraAt: vec3.add(p, offset),
        // Aimed a little over the animal, so the horizon sits in the frame
        // rather than below it.
        aim: vec3.add(vec3.add(p, vec3.scale(fwd, d * 0.15)), [0, d * 0.1, 0]),
      };
    };
    const cur = this.current ? one(this.current) : null;
    const prev = this.previous ? one(this.previous) : null;
    if (!cur) {
      return prev;
    }
    if (!prev) {
      return cur;
    }
    const w = smoothstep((this.time - this.blendStart) / this.blendTime);
    if (w >= 1) {
      this.previous = null;
    }
    return {
      cameraAt: vec3.lerp(prev.cameraAt, cur.cameraAt, w),
      aim: vec3.lerp(prev.aim, cur.aim, w),
    };
  }

  /** Updates a tracker's position (fish: async readback, never waited on). */
  private refresh(t: Tracker | null) {
    if (!t) {
      return;
    }
    const s = t.subject;
    if (s.kind === 'jelly') {
      const j = this.jellyfish.jellies()[s.index];
      if (j) {
        this.accepted(t, [j.pos[0], j.pos[1], j.pos[2]], [0, 1, 0], this.time);
      }
      return;
    }
    if (t.pending) {
      return;
    }
    t.pending = true;
    const asked = this.time;
    const generation = this.generation;
    void this.fish.readFish([s.index]).then(r => {
      t.pending = false;
      if (generation !== this.generation) {
        return;
      }
      if (r[3] <= 0) {
        t.lost = true;
        return;
      }
      this.accepted(
        t,
        [r[0], r[1], r[2]],
        quatForward(r[4], r[5], r[6], r[7]),
        asked,
      );
    });
  }

  private accepted(t: Tracker, pos: Vec3, fwd: Vec3, time: number) {
    const first = !t.sample;
    t.accept(pos, fwd, time);
    if (first && t === this.current) {
      // The transition starts once the new subject has actually been seen.
      this.blendStart = this.time;
    }
    // Lost it: it swam somewhere far out of reach.
    if (vec3.distance(pos, this.pos) > 32) {
      t.lost = true;
    }
  }

  /** Periodically samples a spread of candidates to choose the next subject from. */
  private scan() {
    if (this.scanPending || this.time < this.nextScan) {
      return;
    }
    const all = this.fish.candidates;
    if (!all.length) {
      return;
    }
    // Schools stay near their home, so sample the ones whose home is within
    // reach of the camera; that finds far more usable subjects than sampling
    // the whole ocean, only a fraction of which is ever close enough.
    let pool = all.filter(c => vec3.distance(c.home, this.pos) < 45 + c.roam);
    if (pool.length < 12) {
      pool = all;
    }
    const picks: FollowCandidate[] = [];
    for (let i = 0; i < 64; i++) {
      picks.push(pool[this.rng.int(0, pool.length - 1)]);
    }
    this.scanPending = true;
    const generation = this.generation;
    void this.fish.readFish(picks.map(c => c.index)).then(r => {
      this.scanPending = false;
      if (generation !== this.generation) {
        return;
      }
      this.scanned = picks
        .map((c, k) => ({
          c,
          pos: [r[k * 8], r[k * 8 + 1], r[k * 8 + 2]] as Vec3,
          w: r[k * 8 + 3],
        }))
        .filter(e => e.w > 0)
        .map(({c, pos}) => ({c, pos}));
      this.nextScan = this.time + 1.5;
    });
  }

  private pickSubject() {
    const currentPos = this.current?.estimate(this.time) ?? null;
    const from = currentPos ?? this.look;
    const currentSubject = this.current?.subject;
    const options: {s: Subject; score: number}[] = [];
    // Reach further each time nothing suitable turns up, so a thin patch of
    // water never leaves the camera with nobody to follow.
    const reach = 28 + Math.min(this.empty, 8) * 5;
    const consider = (s: Subject, pos: Readonly<Vec3>) => {
      const d = vec3.distance(pos, from);
      const toCam = vec3.distance(pos, this.pos);
      if (
        toCam > reach ||
        !this.nav.contains([
          pos[0],
          Math.max(pos[1], this.nav.floorAt(pos[0], pos[2]) + 0.1),
          pos[2],
        ])
      ) {
        return;
      }
      // Nearby but not the same spot: ideally 5-12 m on.
      const near = Math.exp(-Math.pow((d - 8) / 6, 2));
      const same =
        currentSubject && s.species === currentSubject.species ? 0.5 : 1;
      // Prefer ones roughly ahead of the camera: less turning.
      const toIt = vec3.normalize(vec3.sub(pos, this.pos));
      const ahead: Vec3 = [
        -Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        -Math.cos(this.yaw) * Math.cos(this.pitch),
      ];
      const facing = 0.4 + 0.6 * Math.max(0, vec3.dot(toIt, ahead));
      const score =
        (INTEREST[s.species] ?? 1) *
        near *
        same *
        facing *
        this.rng.range(0.6, 1.4);
      options.push({s, score});
    };
    for (const {c, pos} of this.scanned) {
      if (currentSubject?.kind === 'fish' && c.index === currentSubject.index) {
        continue;
      }
      consider(
        {
          kind: 'fish',
          index: c.index,
          species: c.species,
          distance: Math.min(
            9,
            Math.max(2.6, c.length * 5 + c.schoolRadius * 1.3),
          ),
        },
        pos,
      );
    }
    // Jellyfish hover high, so following one aims the camera up and away from
    // the reef: they only become eligible after a few other subjects.
    const jellies = this.picks >= JELLY_AFTER ? this.jellyfish.jellies() : [];
    for (let n = 0; n < 4 && jellies.length; n++) {
      const i = this.rng.int(0, jellies.length - 1);
      const j = jellies[i];
      consider(
        {
          kind: 'jelly',
          index: i,
          species: 'jelly',
          distance: Math.max(1.6, j.scale * 9),
        },
        [j.pos[0], j.pos[1], j.pos[2]],
      );
    }
    if (!options.length) {
      // Nothing scanned yet (or nothing but jellyfish early on): try again.
      this.empty++;
      this.switchAt = this.time + 0.5;
      return;
    }
    this.empty = 0;
    this.picks++;
    options.sort((a, b) => b.score - a.score);
    const choice = options[this.rng.int(0, Math.min(2, options.length - 1))].s;
    // Keep tracking the old subject during the transition (unless it was lost
    // or never seen), so the view pans from one to the other.
    const old = this.current;
    this.previous = old && !old.lost && old.sample ? old : this.previous;
    // Vary the shot size the way a documentary cuts: a couple of close ones,
    // then pull out to put the reef, the walls and the open water in frame.
    // Every shot at one distance is what made it feel like a seabed survey.
    const sizes = [1, 1.2, 2.4, 1, 1.7, 3.2];
    const next = new Tracker(choice);
    next.shot = sizes[this.picks % sizes.length] * this.rng.range(0.9, 1.15);
    this.current = next;
    this.blendStart = Infinity;
    this.switchAt = this.time + this.rng.range(11, 16);
  }
}

/** Rotates +Z by the quaternion (x, y, z, w). */
function quatForward(x: number, y: number, z: number, w: number): Vec3 {
  return vec3.normalize([
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
  ]);
}
