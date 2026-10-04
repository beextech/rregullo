// "Qite n’zhivë!": the O in the Rregullo logo is a spirit level, and the bubble (the zhivë) is yours.
// Tilt the phone (or drag, or use the arrow keys) to bring it between the two lines and hold it there.
// The surface it sits on is a little crooked and wanders slowly, so the level needs a steady hand.
// It opens on the whole logo; the camera moves into the O to play and pulls back out to the finished logo at the end.
// One requestAnimationFrame loop; the bubble is a damped spring chasing where the tilt says it should be.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Geometry in the logo's own units (02-symbol-o): the bubble rests at x 658, the lines sit 21 units either side.
const LIMIT = 20.5;     // furthest the bubble can travel before it meets the ring
const ZONE = 5;         // |x| ≤ ZONE: the bubble sits between the two lines
const HOLD = 2.7;       // seconds between the lines to finish
const GAIN = 1.7;       // logo units per degree of tilt: the full travel is about 12°
const PUSH = 30;        // logo units at the slider's end (touch and mouse)
const SPRING = 60, DAMP = 13;   // slightly under critical damping: oil in a vial, it glides and settles
// Camera: centre and width of the view in logo units. The height follows the stage's own aspect (184 / 166).
const ASPECT = 166 / 184;
const CAM = { logo: { x: 357, y: 51, w: 800 }, o: { x: 658, y: 57, w: 184 } };   // the logo keeps a margin for the edge fade

const COPY = {
  tilt: 'Anoje telefonin majtas e djathtas për me e qitë n’vijë.',
  touch: 'Tërhiqe majtas e djathtas për me e qitë n’vijë.',
  mouse: 'Tërhiqe me miun, ose me shigjetat ← →, për me e qitë n’vijë.',
  aim: 'Qite zhivën mes dy vijave dhe mbaje aty.',
  close: 'Edhe pak…',
  hold: 'Mbaje aty…',
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

// How far the screen's left-right edge slopes, in degrees (right side down is positive): exactly what a spirit level
// lying along the screen would read. It comes from gravity in the phone's own axes, so it holds whether the phone
// lies flat or is held up in front of you, and in either landscape direction.
const DEG = Math.PI / 180;
function screenRoll(e) {
  const b = e.beta * DEG, g = e.gamma * DEG;
  const down = { x: Math.cos(b) * Math.sin(g), y: -Math.sin(b) };   // gravity along the device's x and y axes
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  const along = { 0: down.x, 90: -down.y, 180: -down.x, 270: down.y }[((angle % 360) + 360) % 360] ?? down.x;
  return Math.asin(clamp(along, -1, 1)) / DEG;
}

const Tilt = {
  roll: null, base: null, samples: [], listening: false,
  onEvent: null,
  // Resolves true as soon as the sensor reports real values, false if it stays silent.
  listen(timeout = 1200) {
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
      this.listening = true;
      setTimeout(() => finish(this.roll !== null), timeout);
    });
  },
  recalibrate() { this.samples = []; this.base = this.roll; },
  stop() {
    if (this.onEvent) window.removeEventListener('deviceorientation', this.onEvent);
    this.listening = false;
  },
  // Degrees away from the starting position
  get offset() { return this.roll === null || this.base === null ? 0 : this.roll - this.base; },
};

/* ---------------------------------------------------------------- the game */

function mountGame() {
  const root = $('[data-zhive]');
  if (!root) return;
  const ui = {
    level: $('[data-level]'), bubble: $('[data-bubble]'), meter: $('[data-meter]'), stage: $('[data-stage]'),
    control: $('[data-control]'), slider: $('[data-slider]'),
    start: $('[data-start]'), replay: $('[data-replay]'),
    introHint: $('[data-intro-hint]'), step: $('[data-step]'), hint: $('[data-hint]'),
    doneHead: $('[data-done-head]'), announce: $('[data-announce]'),
    sound: $('[data-sound]'), soundLabel: $('[data-sound-label]'),
    panels: Object.fromEntries([...document.querySelectorAll('[data-panel]')].map((p) => [p.dataset.panel, p])),
  };

  const touchy = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  const sensorLikely = touchy && 'DeviceOrientationEvent' in window;
  ui.introHint.textContent = sensorLikely ? COPY.tilt : (touchy ? COPY.touch : COPY.mouse);

  const S = {
    state: 'intro', mode: null, note: '',
    x: -13, v: 0,            // the bubble: offset from centre in logo units, and its speed
    push: 0,                 // touch/mouse input, -1..1 (right lifts the bubble right)
    t: 0, hold: 0, zoneSaid: false,
    bias: 0, phase: [0, 0],  // the crooked, slowly wandering surface
    settle: null,
    cam: { ...CAM.logo }, move: null,   // the camera now, and its move in progress
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
    // a moving bubble stretches a little along the vial, like a real one, and rounds up again when it stops
    const s = Math.min(0.12, Math.abs(S.v) * 0.0015);
    ui.bubble.setAttribute('transform', s < 0.005 ? `translate(${f(S.x)} 0)`
      : `translate(${f(S.x + 658)} 50) scale(${f(1 + s)} ${f(1 - s * 0.6)}) translate(-658 -50)`);
    const c = S.cam, h = c.w * ASPECT;
    ui.level.setAttribute('viewBox', `${f(c.x - c.w / 2)} ${f(c.y - h / 2)} ${f(c.w)} ${f(h)}`);
    ui.meter.setAttribute('stroke-dasharray', `${f(S.hold / HOLD)} 1`);
    ui.meter.classList.toggle('is-empty', S.hold <= 0);
  };

  // Where the surface would push the bubble on its own: a fixed lean plus two slow, out-of-step swells.
  const surface = (t) => {
    const a = S.mode === 'tilt' ? 1 : 1.3;
    return S.bias + a * (4 * Math.sin(t * 0.86 + S.phase[0]) + 2 * Math.sin(t * 1.53 + S.phase[1]));
  };
  const target = () => {
    const input = S.mode === 'tilt' ? -Tilt.offset * GAIN : S.push * PUSH;   // the bubble rises to the high side
    const want = input + surface(S.t);
    return LIMIT * Math.tanh(want / LIMIT);                                    // it slows as it meets the ring
  };

  // Move the camera between the whole logo and the O. Resolves when it arrives.
  const moveTo = (name) => new Promise((resolve) => {
    const to = CAM[name];
    ui.level.classList.toggle('is-logo', name === 'logo');
    if (reduceMotion.matches) { S.cam = { ...to }; S.move = null; draw(); resolve(); return; }
    S.move = { from: { ...S.cam }, to, t: 0, dur: name === 'o' ? 0.9 : 1.1, resolve };
    run();
  });
  const stepCamera = (dt) => {
    const m = S.move;
    m.t = Math.min(1, m.t + dt / m.dur);
    const e = m.t < 0.5 ? 4 * m.t ** 3 : 1 - Math.pow(-2 * m.t + 2, 3) / 2;
    // zoom in log space so the push-in feels even; the centre follows the same curve
    S.cam = {
      x: m.from.x + (m.to.x - m.from.x) * e,
      y: m.from.y + (m.to.y - m.from.y) * e,
      w: Math.exp(Math.log(m.from.w) + (Math.log(m.to.w) - Math.log(m.from.w)) * e),
    };
    if (m.t >= 1) { S.move = null; m.resolve(); }
  };

  let raf = 0, last = 0;
  const frame = (now) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (S.move) stepCamera(dt);

    if (S.state === 'play') {
      S.t += dt;
      // spring toward the target, in small steps so it stays stable on slow frames
      const tx = target();
      for (let i = 0; i < 4; i++) {
        const h = dt / 4;
        S.v += (SPRING * (tx - S.x) - DAMP * S.v) * h;
        S.x += S.v * h;
      }
      if (Math.abs(S.x) > LIMIT) { S.x = Math.sign(S.x) * LIMIT; S.v = 0; }

      const inZone = Math.abs(S.x) <= ZONE;
      S.hold = inZone ? S.hold + dt : Math.max(0, S.hold - dt * 2);
      setHint(S.note || (inZone ? COPY.hold : Math.abs(S.x) <= ZONE * 2 ? COPY.close : COPY.aim));
      if (inZone && !S.zoneSaid) { S.zoneSaid = true; say(COPY.hold); }
      if (!inZone && Math.abs(S.x) > ZONE * 2) S.zoneSaid = false;
      if (S.note && S.t > 4) S.note = '';
      if (S.hold >= HOLD) finish();
    } else if (S.state === 'settle' && S.settle) {
      // the level comes true: the bubble glides to dead centre (ident easing)
      const s = S.settle;
      s.t = Math.min(1, s.t + dt / s.dur);
      const e = 1 - Math.pow(1 - s.t, 3);
      S.x = s.from * (1 - e);
      S.v = 0;
      if (s.t >= 1) { S.settle = null; done(); }
    }
    draw();
    if ((S.state === 'play' || S.settle || S.move) && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const run = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };

  function begin(mode) {
    S.mode = mode;
    S.state = 'play';
    S.t = 0; S.hold = 0; S.zoneSaid = false; S.push = 0; S.v = 0;
    // the surface leans one way or the other, enough to send the bubble well off centre
    const side = Math.random() < 0.5 ? -1 : 1;
    S.bias = side * (12 + Math.random() * 3);
    S.phase = [Math.random() * 6.28, Math.random() * 6.28];
    S.x = clamp(surface(0), -LIMIT, LIMIT) * 0.6 + S.x * 0.4;
    ui.slider.value = 0;
    if (mode === 'tilt') Tilt.recalibrate();
    ui.control.hidden = mode === 'tilt';
    ui.stage.classList.toggle('is-draggable', mode !== 'tilt');
    ui.step.textContent = COPY[mode];
    setHint(S.note || COPY.aim);
    showPanel('play');
    say(`${COPY[mode]} ${S.note}`.trim());
    if (mode !== 'tilt') ui.slider.focus({ preventScroll: true });
    run();
  }

  function finish() {
    S.state = 'settle';
    S.settle = { from: S.x, t: 0, dur: reduceMotion.matches ? 0.2 : 0.7 };
    Sound.play('level', 0.9);
    Sound.play('mark', 0.8, 0.45);
    if (navigator.vibrate) { try { navigator.vibrate(18); } catch {} }
  }

  function done() {
    S.state = 'done';
    S.x = 0; S.hold = HOLD;
    if (S.mode === 'tilt') Tilt.stop();
    ui.stage.classList.remove('is-draggable');
    ui.control.hidden = true;
    showPanel('done');
    ui.doneHead.focus({ preventScroll: true });
    say('Shumë mirë! E qite n’vijë! Për këtë punë je mjeshtër.');
    moveTo('logo');   // back out to the logo, now with its zhivë n’vijë
  }

  // Start: only now ask for the sensor (iOS shows its prompt here), then fall back to touch if it says no.
  ui.start.addEventListener('click', async () => {
    if (S.state !== 'intro') return;
    S.state = 'asking';
    ui.start.disabled = true;
    if (!sensorLikely) { await moveTo('o'); begin(touchy ? 'touch' : 'mouse'); return; }
    // The permission call must be the first thing after the tap (iOS); the camera moves in meanwhile.
    const DOE = window.DeviceOrientationEvent;
    const asking = DOE && typeof DOE.requestPermission === 'function'
      ? DOE.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
    const zoom = moveTo('o');
    const permission = await asking;
    const ok = permission === 'granted' && await Tilt.listen();
    await zoom;
    if (ok) { S.note = ''; begin('tilt'); return; }
    Tilt.stop();
    S.note = permission === 'granted' ? COPY.noSensor : COPY.denied;
    begin('touch');
  });

  ui.replay.addEventListener('click', async () => {
    if (S.state !== 'done') return;
    S.state = 'asking';
    S.note = '';
    S.x = -13; S.v = 0;
    const zoom = moveTo('o');
    if (S.mode === 'tilt' && !(await Tilt.listen())) { Tilt.stop(); S.mode = 'touch'; S.note = COPY.noSensor; }
    await zoom;
    begin(S.mode);
  });

  // Touch and mouse: the slider, a drag anywhere on the level, and the arrow keys.
  ui.slider.addEventListener('input', () => { S.push = ui.slider.value / 100; });
  ui.slider.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    ui.slider.value = clamp(+ui.slider.value + step * (e.shiftKey ? 1 : 4), -100, 100);
    S.push = ui.slider.value / 100;
  });
  let drag = null;
  ui.stage.addEventListener('pointerdown', (e) => {
    if (S.state !== 'play' || S.mode === 'tilt' || e.target === ui.slider) return;
    drag = { id: e.pointerId, x0: e.clientX, start: S.push };
    try { ui.stage.setPointerCapture(e.pointerId); } catch {}
    ui.stage.classList.add('is-dragging');
  });
  ui.stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = (e.clientX - drag.x0) / Math.max(200, ui.stage.clientWidth * 0.6);
    S.push = clamp(drag.start + dx, -1, 1);
    ui.slider.value = Math.round(S.push * 100);
  });
  const endDrag = (e) => { if (drag && drag.id === e.pointerId) { drag = null; ui.stage.classList.remove('is-dragging'); } };
  ui.stage.addEventListener('pointerup', endDrag);
  ui.stage.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', (e) => {
    if (S.state !== 'play' || S.mode === 'tilt' || e.target === ui.slider || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    ui.slider.focus({ preventScroll: true });
    ui.slider.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey }));
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
  // Turning the phone mid-game changes which axis is "left-right": start the level again from there.
  const turned = () => { if (S.mode === 'tilt' && S.state === 'play') Tilt.recalibrate(); };
  if (screen.orientation?.addEventListener) screen.orientation.addEventListener('change', turned);
  else addEventListener('orientationchange', turned);
  addEventListener('pagehide', () => Tilt.stop());

  showPanel('intro');
  draw();
}

mountGame();
