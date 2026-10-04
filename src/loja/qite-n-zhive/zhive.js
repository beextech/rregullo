// "Qite n’zhivë!": a tiny construction spirit level. It sits a little crooked; level it so the bubble (the zhivë)
// settles between the two lines. On phones you tilt the phone itself; anywhere else you grab the level and turn it.
// When it is level it locks with a click, and the Rregullo logo, whose O is this same vial, shows as the reward.
// One requestAnimationFrame loop: the level's angle comes from the input, the bubble is a damped spring chasing it.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The vial, in the level's own units: the bubble travels ±TRAVEL; the lines sit 21 units from the centre, so with
// its half-length of 14.5 the bubble is between them while |x| ≤ 6.5.
const TRAVEL = 43;
const ZONE = 5;          // |x| ≤ ZONE counts as level
const HOLD = 0.45;       // seconds it must stay there before the level locks
const SPREAD = 6;        // degrees: how quickly the bubble runs off as the level tips (a fairly sensitive vial)
const MAX_TILT = 15;
const SPRING = 70, DAMP = 14;   // just under critical damping: oil in a vial, it glides and settles

const COPY = {
  tilt: 'Anoje telefonin majtas e djathtas për me e qitë n’vijë.',
  touch: 'Kape libelën e rrotulloje derisa zhiva të bjerë n’mes.',
  mouse: 'Kape libelën me miun e rrotulloje, ose përdor shigjetat ← →.',
  aim: 'Qite zhivën mes dy vijave.',
  close: 'Edhe pak…',
  hold: 'Ashtu, mbaje…',
  denied: 'Sensori s’u lejua. S’ka gajle, luaje me gisht.',
  noSensor: 'Sensori s’po përgjigjet. S’ka gajle, luaje me gisht.',
};

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = (n) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- sound (opt-in, brand Foley library) */

const Sound = {
  on: false, ctx: null, out: null, buffers: {}, loading: null,
  files: { level: 'level-true', mark: 'sonic-mark' },
  async enable() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.out = this.ctx.createGain();
        this.out.gain.value = 0.9;
        this.out.connect(this.ctx.destination);
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this.loading ||= Promise.all(Object.entries(this.files).map(async ([key, name]) => {
        try {
          const res = await fetch(`/loja/sfx/${name}.mp3`);
          this.buffers[key] = await this.ctx.decodeAudioData(await res.arrayBuffer());
        } catch { /* a missing sound is silence, never an error */ }
      }));
      this.on = true;
      return true;
    } catch { this.on = false; return false; }
  },
  disable() { this.on = false; if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); },
  play(key, gain = 1, delay = 0) {
    if (!this.on || !this.ctx || !this.buffers[key]) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = this.buffers[key];
    src.connect(g).connect(this.out);
    src.start(this.ctx.currentTime + delay);
  },
};

/* ---------------------------------------------------------------- tilt sensor */

// How far the screen's left-right edge slopes, in degrees (right side down is positive): what a spirit level lying
// along the screen would read. It comes from gravity in the phone's own axes, so it holds whether the phone lies
// flat or is held up in front of you, and in either landscape direction.
const DEG = Math.PI / 180;
function screenRoll(e) {
  const b = e.beta * DEG, g = e.gamma * DEG;
  const down = { x: Math.cos(b) * Math.sin(g), y: -Math.sin(b) };   // gravity along the device's x and y axes
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  const along = { 0: down.x, 90: -down.y, 180: -down.x, 270: down.y }[((angle % 360) + 360) % 360] ?? down.x;
  return Math.asin(clamp(along, -1, 1)) / DEG;
}

const Tilt = {
  roll: null, base: null, samples: [], onEvent: null,
  // Resolves true as soon as the sensor reports real values, false if it stays silent.
  listen(timeout = 1200) {
    this.stop();
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      this.onEvent = (e) => {
        if (e.gamma == null || e.beta == null) return;
        const r = screenRoll(e);
        if (!Number.isFinite(r)) return;
        this.roll = r;
        // Calibrate from where the phone is when the game starts: average the first few readings.
        if (this.samples.length < 6) {
          this.samples.push(r);
          this.base = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
        }
        finish(true);
      };
      window.addEventListener('deviceorientation', this.onEvent);
      setTimeout(() => finish(this.roll !== null), timeout);
    });
  },
  recalibrate() { this.samples = []; this.base = this.roll; },
  stop() { if (this.onEvent) window.removeEventListener('deviceorientation', this.onEvent); this.onEvent = null; },
  get offset() { return this.roll === null || this.base === null ? 0 : this.roll - this.base; },
};

/* ---------------------------------------------------------------- the game */

function mountGame() {
  const root = $('[data-zhive]');
  if (!root) return;
  const ui = {
    scene: $('[data-scene]'), level: $('[data-level]'), bubble: $('[data-bubble]'), shadow: $('[data-shadow]'),
    stage: $('[data-stage]'), start: $('[data-start]'), replay: $('[data-replay]'),
    introHint: $('[data-intro-hint]'), step: $('[data-step]'), hint: $('[data-hint]'),
    doneHead: $('[data-done-head]'), announce: $('[data-announce]'),
    sound: $('[data-sound]'), soundLabel: $('[data-sound-label]'),
    panels: Object.fromEntries([...document.querySelectorAll('[data-panel]')].map((p) => [p.dataset.panel, p])),
  };

  const touchy = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  const sensorLikely = touchy && 'DeviceOrientationEvent' in window;
  ui.introHint.textContent = sensorLikely ? COPY.tilt : (touchy ? COPY.touch : COPY.mouse);

  const S = {
    state: 'intro', mode: null, note: '', t: 0,
    bias: 5, phase: 0,      // how crooked the surface is, and its slow sway
    input: 0,               // the player's correction in degrees (drag, keys, or the phone's own tilt)
    roll: 0,                // smoothed sensor reading
    theta: 5, x: 0, v: 0,   // the level's angle, the bubble's offset and speed
    hold: 0, near: false, lock: null,
  };

  const showPanel = (name) => {
    for (const [key, p] of Object.entries(ui.panels)) {
      const on = key === name;
      p.classList.toggle('is-off', !on);
      p.setAttribute('aria-hidden', String(!on));
      p.inert = !on;
    }
    root.dataset.state = name;
  };
  const say = (text) => { ui.announce.textContent = ''; requestAnimationFrame(() => { ui.announce.textContent = text; }); };
  const setHint = (text) => { if (ui.hint.textContent !== text) ui.hint.textContent = text; };

  const draw = () => {
    ui.level.setAttribute('transform', `translate(180 80) rotate(${f(S.theta)})`);
    // a moving bubble stretches a little along the vial, like a real one, and rounds up again when it stops
    const s = Math.min(0.14, Math.abs(S.v) * 0.0016);
    ui.bubble.setAttribute('transform', `translate(${f(S.x)} 0)${s > 0.005 ? ` scale(${f(1 + s)} ${f(1 - s * 0.6)})` : ''}`);
    ui.shadow.setAttribute('rx', f(150 * Math.cos(S.theta * DEG)));
    ui.scene.setAttribute('aria-valuenow', Math.round(S.theta * 10) / 10);
    ui.scene.setAttribute('aria-valuetext', Math.abs(S.x) <= ZONE ? 'Në nivel' : (S.x < 0 ? 'Zhiva është majtas' : 'Zhiva është djathtas'));
  };

  // The surface sways a touch, so the level never sits dead still: a steady hand, not a frozen one.
  const sway = (t) => 0.22 * Math.sin(t * 0.9 + S.phase) + 0.1 * Math.sin(t * 2.3 + S.phase * 2);
  const angle = () => {
    if (S.mode === 'tilt') { S.roll += (Tilt.offset - S.roll) * 0.25; return S.bias + S.roll + sway(S.t); }
    return S.bias + S.input + sway(S.t);
  };
  const spring = (target, dt) => {
    for (let i = 0; i < 4; i++) {
      const h = dt / 4;
      S.v += (SPRING * (target - S.x) - DAMP * S.v) * h;
      S.x += S.v * h;
    }
    if (Math.abs(S.x) > TRAVEL) { S.x = Math.sign(S.x) * TRAVEL; S.v *= -0.2; }   // a soft knock at the end of the vial
  };

  let raf = 0, last = 0, visible = true;
  const frame = (now) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    S.t += dt;

    if (S.state === 'intro') {
      S.theta = S.bias + (reduceMotion.matches ? 0 : sway(S.t) * 2);
      spring(-TRAVEL * Math.tanh(S.theta / SPREAD), dt);
    } else if (S.state === 'play') {
      S.theta = clamp(angle(), -MAX_TILT, MAX_TILT);
      spring(-TRAVEL * Math.tanh(S.theta / SPREAD), dt);   // it runs to the high end
      const inZone = Math.abs(S.x) <= ZONE && Math.abs(S.v) < 40;
      S.hold = inZone ? S.hold + dt : 0;
      const near = Math.abs(S.x) <= ZONE * 2.5;
      setHint(S.note && S.t < 4 ? S.note : inZone ? COPY.hold : near ? COPY.close : COPY.aim);
      if (near && !S.near) say(COPY.close);
      S.near = near;
      if (S.hold >= HOLD) lock();
    } else if (S.state === 'lock') {
      // the level snaps true: angle and bubble ease to zero together
      const L = S.lock;
      L.t = Math.min(1, L.t + dt / L.dur);
      const e = 1 - Math.pow(1 - L.t, 3);
      S.theta = L.theta * (1 - e);
      S.x = L.x * (1 - e); S.v = 0;
      if (L.t >= 1) won();
    }
    draw();
    const live = S.state === 'play' || S.state === 'lock' || (S.state === 'intro' && !reduceMotion.matches && visible);
    if (live && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const run = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };

  const lean = () => {
    S.bias = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3);
    S.phase = Math.random() * 6.28;
  };

  function begin(mode) {
    S.mode = mode;
    S.state = 'play';
    S.t = 0; S.hold = 0; S.input = 0; S.roll = 0; S.near = false;
    if (mode === 'tilt') Tilt.recalibrate();
    ui.step.textContent = COPY[mode];
    setHint(S.note || COPY.aim);
    root.classList.remove('is-won');
    showPanel('play');
    say(`${COPY[mode]} ${S.note}`.trim());
    if (mode !== 'tilt') ui.scene.focus({ preventScroll: true });
    run();
  }

  function lock() {
    S.state = 'lock';
    S.lock = { theta: S.theta, x: S.x, t: 0, dur: reduceMotion.matches ? 0.05 : 0.28 };
    root.classList.add('is-locking');
    Sound.play('level', 0.9);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
  }

  function won() {
    S.state = 'done';
    S.theta = 0; S.x = 0;
    if (S.mode === 'tilt') Tilt.stop();
    setTimeout(() => root.classList.remove('is-locking'), 160);
    root.classList.add('is-won');
    Sound.play('mark', 0.8, 0.5);
    showPanel('done');
    ui.doneHead.focus({ preventScroll: true });
    say('Në nivel. Për këtë punë je mjeshtër.');
  }

  // Start: only now ask for the sensor (iOS shows its prompt here), then fall back to touch if it says no.
  ui.start.addEventListener('click', async () => {
    if (S.state !== 'intro') return;
    S.state = 'asking';
    ui.start.disabled = true;
    if (!sensorLikely) { begin(touchy ? 'touch' : 'mouse'); return; }
    const DOE = window.DeviceOrientationEvent;
    let permission = 'granted';
    if (DOE && typeof DOE.requestPermission === 'function') {
      try { permission = await DOE.requestPermission(); } catch { permission = 'denied'; }
    }
    if (permission === 'granted' && await Tilt.listen()) { S.note = ''; begin('tilt'); return; }
    Tilt.stop();
    S.note = permission === 'granted' ? COPY.noSensor : COPY.denied;
    begin('touch');
  });

  ui.replay.addEventListener('click', async () => {
    if (S.state !== 'done') return;
    S.state = 'asking';
    S.note = '';
    lean();
    if (S.mode === 'tilt' && !(await Tilt.listen())) { Tilt.stop(); S.mode = 'touch'; S.note = COPY.noSensor; }
    begin(S.mode);
  });

  // Grab and turn: drag an end up or down to tip it, or push the bubble sideways from the middle.
  // Geared down so small corrections are easy; it works with or without the sensor.
  let drag = null;
  const toUnits = () => 360 / ui.scene.getBoundingClientRect().width;
  ui.scene.addEventListener('pointerdown', (e) => {
    if (S.state !== 'play') return;
    const r = ui.scene.getBoundingClientRect();
    const side = clamp(((e.clientX - r.left) * toUnits() - 180) / 90, -1, 1);
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, side, start: S.input };
    try { ui.scene.setPointerCapture(e.pointerId); } catch {}
    ui.stage.classList.add('is-dragging');
    if (S.mode === 'tilt') { S.mode = 'touch'; S.input = S.roll; drag.start = S.input; Tilt.stop(); ui.step.textContent = COPY.touch; }
  });
  ui.scene.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const k = toUnits();
    const dx = (e.clientX - drag.x0) * k, dy = (e.clientY - drag.y0) * k;
    S.input = clamp(drag.start + drag.side * dy * 0.08 - dx * 0.04, -MAX_TILT - 8, MAX_TILT + 8);
  });
  const endDrag = (e) => { if (drag && drag.id === e.pointerId) { drag = null; ui.stage.classList.remove('is-dragging'); } };
  ui.scene.addEventListener('pointerup', endDrag);
  ui.scene.addEventListener('pointercancel', endDrag);
  // Keys: ← → move the bubble that way (Shift for a fine touch)
  ui.scene.addEventListener('keydown', (e) => {
    if (S.state !== 'play') return;
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    if (S.mode === 'tilt') { S.mode = 'mouse'; S.input = S.roll; Tilt.stop(); ui.step.textContent = COPY.mouse; }
    S.input -= dir * (e.shiftKey ? 0.1 : 0.4);
  });

  // Sound switch: off until the visitor turns it on
  if (ui.sound) {
    ui.sound.hidden = false;
    ui.sound.addEventListener('click', async () => {
      const turnOn = ui.sound.getAttribute('aria-pressed') !== 'true';
      const ok = turnOn ? await Sound.enable() : (Sound.disable(), true);
      const on = turnOn && ok;
      ui.sound.setAttribute('aria-pressed', String(on));
      ui.soundLabel.textContent = on ? 'Zëri: ndezur' : 'Zëri: fikur';
      if (turnOn && !ok) ui.sound.hidden = true;     // no audio on this device: hide the switch
    });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) run(); }).observe(ui.scene);
  }
  // Turning the phone mid-game changes which edge is "left-right": level from where it is now.
  const turned = () => { if (S.mode === 'tilt' && S.state === 'play') { Tilt.recalibrate(); S.roll = 0; } };
  if (screen.orientation?.addEventListener) screen.orientation.addEventListener('change', turned);
  else addEventListener('orientationchange', turned);
  addEventListener('pagehide', () => Tilt.stop());
  reduceMotion.addEventListener?.('change', run);

  lean();
  S.theta = S.bias;
  S.x = -TRAVEL * Math.tanh(S.theta / SPREAD);
  showPanel('intro');
  draw();
  run();
}

mountGame();
