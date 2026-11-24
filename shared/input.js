// Keyboard state plus a floating virtual joystick for touch (also works
// with a mouse: press and drag anywhere on the element).

export class Keys {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      if (!this.down.has(e.key)) this.pressed.add(e.key);
      this.down.add(e.key);
    });
    addEventListener('keyup', (e) => this.down.delete(e.key));
    addEventListener('blur', () => this.down.clear());
  }

  any(...keys) {
    return keys.some((k) => this.down.has(k));
  }

  // True once per key press; call endFrame() after each update.
  wasPressed(...keys) {
    return keys.some((k) => this.pressed.has(k));
  }

  endFrame() {
    this.pressed.clear();
  }
}

export class Joystick {
  constructor(el, { radius = 60 } = {}) {
    this.radius = radius;
    this.active = false;
    this.pointerId = null;
    this.baseX = 0;
    this.baseY = 0;
    this.knobX = 0;
    this.knobY = 0;
    this.x = 0; // -1..1
    this.y = 0; // -1..1

    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (this.active) return;
      this.active = true;
      this.pointerId = e.pointerId;
      const p = this.local(el, e);
      this.baseX = this.knobX = p.x;
      this.baseY = this.knobY = p.y;
      this.x = this.y = 0;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety; dragging still works without it */
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.active || e.pointerId !== this.pointerId) return;
      const p = this.local(el, e);
      let dx = p.x - this.baseX;
      let dy = p.y - this.baseY;
      const d = Math.hypot(dx, dy);
      if (d > this.radius) {
        // Drag the base along so the stick never "runs out".
        const over = d - this.radius;
        this.baseX += (dx / d) * over;
        this.baseY += (dy / d) * over;
        dx = p.x - this.baseX;
        dy = p.y - this.baseY;
      }
      this.knobX = p.x;
      this.knobY = p.y;
      this.x = dx / this.radius;
      this.y = dy / this.radius;
    });
    const end = (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.active = false;
      this.pointerId = null;
      this.x = this.y = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  local(el, e) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  get magnitude() {
    return Math.min(1, Math.hypot(this.x, this.y));
  }
}
