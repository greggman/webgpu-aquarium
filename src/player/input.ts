// Unified input: keyboard + mouse (pointer lock), touch (virtual stick + look
// drag), and gamepad. Produces a per-frame move vector and look delta.

export interface InputState {
  /** Local move intent: x right, y up, z forward; each in [-1, 1]. */
  move: [number, number, number];
  /** Look delta in radians this frame (yaw, pitch). */
  look: [number, number];
  sprint: boolean;
}

export class Input {
  /** Seconds since the last user input. */
  idleTime = 0;
  private keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private dragging = false;
  private stickId: number | null = null;
  private stickOrigin: [number, number] = [0, 0];
  private stickPos: [number, number] = [0, 0];
  private lookTouches = new Map<number, [number, number]>();
  private touchLookDX = 0;
  private touchLookDY = 0;
  private touchVertical = 0;
  private stickEl: HTMLDivElement;
  private knobEl: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.stickEl = document.createElement('div');
    this.stickEl.className = 'stick';
    this.stickEl.hidden = true;
    this.knobEl = document.createElement('div');
    this.stickEl.appendChild(this.knobEl);
    document.body.appendChild(this.stickEl);

    window.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey) {
        return;
      }
      this.keys.add(e.code);
      this.activity();
      if (e.code === 'Space' || e.code.startsWith('Arrow')) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) {
        return;
      }
      this.activity();
      if (canvas.requestPointerLock && document.pointerLockElement !== canvas) {
        const r = canvas.requestPointerLock() as unknown as
          Promise<void> | undefined;
        r?.catch?.(() => (this.dragging = true));
      }
      this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', e => {
      if (document.pointerLockElement === canvas || this.dragging) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
        this.activity();
      }
    });

    canvas.addEventListener('touchstart', e => this.onTouchStart(e), {
      passive: false,
    });
    canvas.addEventListener('touchmove', e => this.onTouchMove(e), {
      passive: false,
    });
    canvas.addEventListener('touchend', e => this.onTouchEnd(e));
    canvas.addEventListener('touchcancel', e => this.onTouchEnd(e));
  }

  private activity() {
    this.idleTime = 0;
  }

  private onTouchStart(e: TouchEvent) {
    e.preventDefault();
    this.activity();
    const half = this.canvas.clientWidth / 2;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < half && this.stickId === null) {
        this.stickId = t.identifier;
        this.stickOrigin = [t.clientX, t.clientY];
        this.stickPos = [t.clientX, t.clientY];
        this.stickEl.hidden = false;
        this.stickEl.style.left = `${t.clientX}px`;
        this.stickEl.style.top = `${t.clientY}px`;
        this.knobEl.style.transform = '';
      } else {
        this.lookTouches.set(t.identifier, [t.clientX, t.clientY]);
      }
    }
  }

  private onTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.activity();
    let dySum = 0;
    let moved = 0;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickPos = [t.clientX, t.clientY];
        const [dx, dy] = this.stickVector();
        this.knobEl.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      } else {
        const prev = this.lookTouches.get(t.identifier);
        if (prev) {
          const dx = t.clientX - prev[0];
          const dy = t.clientY - prev[1];
          this.lookTouches.set(t.identifier, [t.clientX, t.clientY]);
          dySum += dy;
          moved++;
          if (this.lookTouches.size === 1) {
            this.touchLookDX += dx;
            this.touchLookDY += dy;
          }
        }
      }
    }
    // Two fingers on the look side: vertical drag swims up/down.
    if (this.lookTouches.size >= 2 && moved) {
      this.touchVertical = Math.max(-1, Math.min(1, -dySum / moved / 6));
    }
  }

  private onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null;
        this.stickEl.hidden = true;
      }
      this.lookTouches.delete(t.identifier);
    }
    if (this.lookTouches.size < 2) {
      this.touchVertical = 0;
    }
  }

  private stickVector(): [number, number] {
    const dx = (this.stickPos[0] - this.stickOrigin[0]) / 50;
    const dy = (this.stickPos[1] - this.stickOrigin[1]) / 50;
    const l = Math.hypot(dx, dy);
    return l > 1 ? [dx / l, dy / l] : [dx, dy];
  }

  /** Reads and clears accumulated input for this frame. */
  read(dt: number): InputState {
    this.idleTime += dt;
    const k = this.keys;
    const axis = (pos: string[], neg: string[]) =>
      (pos.some(c => k.has(c)) ? 1 : 0) - (neg.some(c => k.has(c)) ? 1 : 0);
    const move: [number, number, number] = [
      axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']),
      axis(['Space', 'KeyE'], ['KeyC', 'KeyQ', 'ControlLeft']),
      axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
    ];
    const mouseSens = 0.0022;
    const touchSens = 0.005;
    const look: [number, number] = [
      -this.mouseDX * mouseSens - this.touchLookDX * touchSens,
      -this.mouseDY * mouseSens - this.touchLookDY * touchSens,
    ];
    this.mouseDX = this.mouseDY = this.touchLookDX = this.touchLookDY = 0;
    let sprint = k.has('ShiftLeft') || k.has('ShiftRight');

    if (this.stickId !== null) {
      const [sx, sy] = this.stickVector();
      move[0] += sx;
      move[2] -= sy;
      sprint ||= Math.hypot(sx, sy) > 0.95;
    }
    move[1] += this.touchVertical;

    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) {
        continue;
      }
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      const lx = dz(pad.axes[0] ?? 0);
      const ly = dz(pad.axes[1] ?? 0);
      const rx = dz(pad.axes[2] ?? 0);
      const ry = dz(pad.axes[3] ?? 0);
      const up = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      if (
        lx ||
        ly ||
        rx ||
        ry ||
        Math.abs(up) > 0.05 ||
        pad.buttons.some(b => b.pressed)
      ) {
        this.activity();
      }
      move[0] += lx;
      move[2] -= ly;
      move[1] += up;
      look[0] -= rx * 2.2 * dt;
      look[1] -= ry * 2.2 * dt;
      sprint ||= !!(pad.buttons[5]?.pressed || pad.buttons[10]?.pressed);
    }

    for (let i = 0; i < 3; i++) {
      move[i] = Math.max(-1, Math.min(1, move[i]));
    }
    if (!this.enabled) {
      return {move: [0, 0, 0], look: [0, 0], sprint: false};
    }
    return {move, look, sprint};
  }
}
