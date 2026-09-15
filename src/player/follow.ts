// Creature-following auto camera: swims alongside one animal (a fish, a
// school's leader, a ray or a jellyfish), keeping it framed, and every 10-15
// seconds picks another one nearby and glides over to it.
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

export class CreatureCam {
  private nav: NavVolume;
  private fish: FishSystem;
  private jellyfish: JellyfishSystem;
  private rng: Rng;

  private time = 0;
  private pos: Vec3 = [0, 0, 0];
  private vel: Vec3 = [0, 0, 0];
  private look: Vec3 = [0, 0, 1];
  private heading: Vec3 = [0, 0, 1];
  private subject: Subject | null = null;
  private sample: Sample | null = null;
  private prevSample: Sample | null = null;
  private subjectVel: Vec3 = [0, 0, 0];
  private switchAt = 0;
  /** Side of the subject the camera sits on, and a slow orbit around it. */
  private side = 1;
  private orbitPhase = 0;
  private readPending = false;
  private scanPending = false;
  private nextScan = 0;
  /** Recently scanned candidate positions. */
  private scanned: {c: FollowCandidate; pos: Vec3}[] = [];
  private generation = 0;

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
    return this.subject ? `${this.subject.species} #${this.subject.index}` : '';
  }

  /** True once there is something to follow (until then use another camera). */
  get ready(): boolean {
    return this.subject !== null && this.sample !== null;
  }

  /** Moves the camera to a pose without restarting the search for a subject. */
  syncPose(pose: CameraPose) {
    this.pos = vec3.clone(pose.pos);
    this.vel = [0, 0, 0];
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
    this.subject = null;
    this.sample = null;
    this.prevSample = null;
    this.scanned = [];
    this.nextScan = 0;
    this.generation++;
  }

  update(dt: number): CameraPose {
    this.time += dt;
    this.scan();
    if (!this.subject || this.time >= this.switchAt) {
      this.pickSubject();
    }
    this.refreshSubject();

    const s = this.subject;
    const current = this.estimate();
    if (s && current) {
      // Smooth the subject's heading so the camera doesn't swing each time
      // the fish flicks its tail.
      const k = 1 - Math.exp(-dt * 0.8);
      this.heading = vec3.normalize(
        vec3.add(
          vec3.scale(this.heading, 1 - k),
          vec3.scale([current.fwd[0], current.fwd[1] * 0.3, current.fwd[2]], k),
        ),
      );
      const fwd = this.heading;
      const right = vec3.normalize(vec3.cross([0, 1, 0], fwd));
      // Sit behind and to one side, a little above, slowly orbiting.
      this.orbitPhase += dt * 0.08;
      const angle = this.side * (0.9 + Math.sin(this.orbitPhase) * 0.5);
      const d = s.distance;
      // (floorAt already includes the camera's clearance above the ground.)
      const nearBottom =
        current.pos[1] - this.nav.floorAt(current.pos[0], current.pos[2]) < 1.2;
      const offset = vec3.add(
        vec3.add(
          vec3.scale(fwd, -Math.cos(angle) * d),
          vec3.scale(right, Math.sin(angle) * d),
        ),
        // Higher above animals down among the coral, so the camera looks
        // over the reef at them instead of pushing through it.
        [0, d * (nearBottom ? 0.6 : 0.28), 0],
      );
      const desired = vec3.add(current.pos, offset);
      // Critically damped spring toward the desired spot, speed-limited so
      // switching subjects is a glide, not a jump.
      const omega = 1.3;
      for (let i = 0; i < 3; i++) {
        const x = this.pos[i] - desired[i];
        const a = -omega * omega * x - 2 * omega * this.vel[i];
        this.vel[i] += a * dt;
      }
      const speed = vec3.length(this.vel);
      const maxSpeed = 3.2;
      if (speed > maxSpeed) {
        this.vel = vec3.scale(this.vel, maxSpeed / speed);
      }
      this.pos = vec3.add(this.pos, vec3.scale(this.vel, dt));
      this.nav.constrain(this.pos, this.vel, dt);
      // Aim a little ahead of the subject, eased.
      const aim = vec3.add(current.pos, vec3.scale(fwd, d * 0.15));
      const la = 1 - Math.exp(-dt * 2.2);
      this.look = vec3.add(vec3.scale(this.look, 1 - la), vec3.scale(aim, la));
    }
    const dir = vec3.sub(this.look, this.pos);
    const {yaw, pitch} = anglesFromDirection(
      vec3.length(dir) > 1e-3 ? dir : [0, 0, -1],
    );
    // A touch of banking from sideways motion.
    const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const roll = Math.max(
      -0.08,
      Math.min(0.08, -vec3.dot(this.vel, right) * 0.03),
    );
    return {
      pos: vec3.clone(this.pos),
      yaw,
      pitch: Math.max(-1.1, Math.min(1.1, pitch)),
      roll,
    };
  }

  /** Subject position now: the last sample moved along by its velocity. */
  private estimate(): {pos: Vec3; fwd: Vec3} | null {
    if (!this.sample) {
      return null;
    }
    const age = Math.min(this.time - this.sample.time, 0.5);
    return {
      pos: vec3.add(this.sample.pos, vec3.scale(this.subjectVel, age)),
      fwd: this.sample.fwd,
    };
  }

  /** Requests the subject's position if no request is in flight. */
  private refreshSubject() {
    const s = this.subject;
    if (!s) {
      return;
    }
    if (s.kind === 'jelly') {
      const j = this.jellyfish.jellies()[s.index];
      if (j) {
        this.accept([j.pos[0], j.pos[1], j.pos[2]], [0, 1, 0], this.time);
      }
      return;
    }
    if (this.readPending) {
      return;
    }
    this.readPending = true;
    const asked = this.time;
    const generation = this.generation;
    const subject = s;
    void this.fish.readFish([s.index]).then(r => {
      this.readPending = false;
      if (generation !== this.generation || subject !== this.subject) {
        return;
      }
      if (r[3] <= 0) {
        this.subject = null;
        return;
      }
      this.accept(
        [r[0], r[1], r[2]],
        quatForward(r[4], r[5], r[6], r[7]),
        asked,
      );
    });
  }

  private accept(pos: Vec3, fwd: Vec3, time: number) {
    this.prevSample = this.sample;
    this.sample = {pos, fwd, time};
    const prev = this.prevSample;
    if (prev && time > prev.time + 1e-3) {
      const v = vec3.scale(vec3.sub(pos, prev.pos), 1 / (time - prev.time));
      // Low-pass: readback timing jitters.
      this.subjectVel = vec3.add(
        vec3.scale(this.subjectVel, 0.6),
        vec3.scale(v, 0.4),
      );
    }
    // Lost it: it swam somewhere the camera can't follow, or far away.
    if (vec3.distance(pos, this.pos) > 30) {
      this.subject = null;
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
    const picks: FollowCandidate[] = [];
    for (let i = 0; i < 48; i++) {
      picks.push(all[this.rng.int(0, all.length - 1)]);
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
    const from = this.sample?.pos ?? this.look;
    const options: {s: Subject; score: number}[] = [];
    const consider = (s: Subject, pos: Readonly<Vec3>) => {
      const d = vec3.distance(pos, from);
      const toCam = vec3.distance(pos, this.pos);
      if (
        toCam > 28 ||
        !this.nav.contains([
          pos[0],
          Math.max(pos[1], this.nav.floorAt(pos[0], pos[2]) + 0.1),
          pos[2],
        ])
      ) {
        return;
      }
      // Nearby but not the same spot: ideally 5-15 m on.
      const near = Math.exp(-Math.pow((d - 9) / 8, 2));
      const same = this.subject && s.species === this.subject.species ? 0.5 : 1;
      const score =
        (INTEREST[s.species] ?? 1) * near * same * this.rng.range(0.6, 1.4);
      options.push({s, score});
    };
    for (const {c, pos} of this.scanned) {
      if (this.subject?.kind === 'fish' && c.index === this.subject.index) {
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
    const jellies = this.jellyfish.jellies();
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
      // Nothing scanned yet: try again shortly.
      this.switchAt = this.time + 0.5;
      return;
    }
    options.sort((a, b) => b.score - a.score);
    const choice = options[this.rng.int(0, Math.min(2, options.length - 1))].s;
    this.subject = choice;
    this.sample = null;
    this.prevSample = null;
    this.subjectVel = [0, 0, 0];
    this.side = this.rng.bool() ? 1 : -1;
    this.switchAt = this.time + this.rng.range(10, 15);
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
