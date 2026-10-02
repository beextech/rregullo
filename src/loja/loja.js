// "Prej një rubineti që pikon…": a leaking tap you can fix in two moves.
// 1. Close the tap: it slows, but it still drips. 2. Tighten the loose bonnet nut with a spanner, three strokes.
// One requestAnimationFrame loop runs on a game clock; every timer is a tween on that clock, so a reset
// clears everything at once and nothing can fire after it. The scene is SVG drawn in a light 2.5D projection.

const NS = 'http://www.w3.org/2000/svg';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Scene geometry, in the SVG's own units (viewBox 60 200 560 500)
const K = 0.32;                         // camera elevation: a horizontal circle is drawn as an ellipse K tall
const CX = 250;                         // the tap's vertical axis
const HANDLE_Y = 262, HANDLE_T = 12;    // cross handle top plane and thickness
const NUT_R = 36, NUT_H = 24, NUT_SEAT = 330; // bonnet nut: radius across corners, height, where it sits when tight
const GAP0 = 6;                         // how far the loose nut stands proud of its seat
const WRENCH_Y = 316;                   // spanner plane (middle of the nut)
const TIP = { x: 520, y: 469 };         // where the drop hangs (aerator mouth)
const FLOOR_Y = 632;                    // where it lands (basin floor, at the drain)
const RMAX = 7.4;                       // drop radius when it lets go
const GRAV = 3600;                      // units / s²: a 160-unit fall in about 0.3 s
const STROKES = 3;                      // spanner strokes to seat the nut
const STROKE_FROM = 60, STROKE_TO = 0; // spanner angle (degrees) at the start and end of each 60° stroke

// Copy. Kosovo Albanian, short, in the site's voice.
const COPY = {
  close: ['Mbylle rubinetin.', 'Tërhiqe dorezën djathtas, ose prek mbi të.'],
  wrongWay: ['Mbylle rubinetin.', 'Nga ana tjetër: djathtas.'],
  stillDrips: ['Prapë pikon.', 'Dadoja nën dorezë s’është shtrënguar mirë. Shtrëngoje me çelës.'],
  stroke1: ['Edhe pak.', 'Tërhiqe çelësin djathtas, ose prek mbi të.'],
  stroke2: ['Edhe një herë.', 'Tërhiqe çelësin djathtas, ose prek mbi të.'],
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rad = (d) => (d * Math.PI) / 180;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const f = (n) => Math.round(n * 100) / 100;
// Local top-down shape (u along, v across) turned by angle a and laid on the plane at height y.
const planeMatrix = (a, x, y) => {
  const c = Math.cos(a), s = Math.sin(a);
  return `matrix(${f(c)} ${f(K * s)} ${f(-s)} ${f(K * c)} ${f(x)} ${f(y)})`;
};
const mix = (c1, c2, t) => {
  const p = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(lerp(p(c1, i), p(c2, i), t))).join(',')})`;
};

/* ---------------------------------------------------------------- sound (opt-in, brand Foley library) */

const Sound = {
  on: false, ctx: null, out: null, buffers: {}, loading: null,
  files: { stop: 'handle-stop', seat: 'wrench-seat', click: 'wrench-click', grip: 'grip', mark: 'sonic-mark' },
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
  play(key, gain = 1) {
    if (!this.on || !this.ctx || !this.buffers[key]) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = this.buffers[key];
    src.connect(g).connect(this.out);
    src.start();
  },
  // A drop landing in a thin film of water: a tiny resonating bubble whose pitch rises as it closes.
  drip(size = 1) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f0 = (1150 + Math.random() * 520) / Math.sqrt(size);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0 * 0.62, t);
    osc.frequency.exponentialRampToValueAtTime(f0, t + 0.035);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 * size, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.13);
  },
};

/* ---------------------------------------------------------------- scene objects */

function buildScene(svg) {
  const parts = {
    armsBack: $('[data-arms-back]', svg), armsFront: $('[data-arms-front]', svg),
    capMark: $('[data-cap-mark]', svg), neck: $('[data-neck]', svg), nut: $('[data-nut]', svg),
    wrench: $('[data-wrench-body]', svg), clipBack: $('[data-clip-back]', svg), clipFront: $('[data-clip-front]', svg),
    drops: $('[data-drops]', svg), hang: $('[data-hang]', svg), ripples: $('[data-ripples]', svg), puddle: $('[data-puddle]', svg),
    hintHandle: $('[data-hint-handle]', svg), hintWrench: $('[data-hint-wrench]', svg), nutRing: $('[data-nut-ring]', svg),
  };

  // Cross handle: four tapered arms in Paper polymer, extruded by stacking layers (side tones, then the lit top).
  const ARM = 'M8 -9C30 -6.6 48 -6.6 60 -8.4A8.4 8.4 0 0 1 60 8.4C48 6.6 30 6.6 8 9Z';
  const LAYERS = 10;
  parts.arms = [0, 1, 2, 3].map(() => {
    const g = el('g');
    const layers = [];
    for (let l = 0; l < LAYERS; l++) {
      const top = l === LAYERS - 1;
      layers.push({
        node: el('path', { d: ARM, fill: top ? 'url(#polyTop)' : (l === 0 ? '#6C6F69' : '#A3A6A0') }, g),
        dy: HANDLE_T * (1 - l / (LAYERS - 1)),
      });
    }
    el('path', { d: 'M14 -5.5C32 -4.2 46 -4.2 57 -5.2', fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': '.55', 'stroke-width': '1.2', 'stroke-linecap': 'round' }, g);
    return { g, layers, glint: g.lastChild, depth: 0 };
  });

  // Bonnet nut: six side faces, a top face and a chamfer ring, recomputed from its angle.
  parts.nutFaces = [];
  for (let j = 0; j < 6; j++) parts.nutFaces.push(el('path', { 'stroke-linejoin': 'round' }, parts.nut));
  parts.nutTop = el('path', { fill: 'url(#chromeTop)' }, parts.nut);
  parts.nutChamfer = el('ellipse', { fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': '.22', 'stroke-width': '1' }, parts.nut);

  // Open-end spanner in satin steel with one petrol sleeve (the film's single material accent).
  const SPANNER = 'M-46 -31.5L-44 -44A52 52 0 0 1 37 -40L66 -12L172 -10A10 10 0 0 1 172 10L66 12L37 40A52 52 0 0 1 -44 44L-46 31.5L18 31.5A31.5 31.5 0 0 0 18 -31.5Z'
    + 'M169.5 0A4.5 4.5 0 1 0 160.5 0A4.5 4.5 0 1 0 169.5 0Z';
  const SLEEVE = 'M90 -12.6L144 -11.8A4 11.8 0 0 1 144 11.8L90 12.6A4 12.6 0 0 1 90 -12.6Z';
  parts.wrenchLayers = [];
  const WL = 7;
  for (let l = 0; l < WL; l++) {
    const top = l === WL - 1;
    parts.wrenchLayers.push({ node: el('path', { d: SPANNER, 'fill-rule': 'evenodd', fill: top ? 'url(#steel)' : (l === 0 ? '#2E3236' : '#5F646A') }, parts.wrench), dy: 7 * (1 - l / (WL - 1)) });
  }
  parts.wrenchLayers.push({ node: el('path', { d: SLEEVE, fill: '#1E3A40' }, parts.wrench), dy: 0 });
  parts.wrenchLayers.push({ node: el('path', { d: SLEEVE, fill: 'url(#petrol)' }, parts.wrench), dy: -2.2 });
  parts.wrenchLayers.push({ node: el('path', { d: 'M-30 -38A46 46 0 0 1 30 -36L58 -11.5L170 -9.4', fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': '.5', 'stroke-width': '1.1' }, parts.wrench), dy: 0 });

  parts.hangGlint = el('ellipse', { class: 'drop-glint', rx: '1.5', ry: '2.1' }, parts.drops);
  return parts;
}

/* ---------------------------------------------------------------- game */

function mountGame() {
  const root = $('[data-phase]');
  const svg = $('[data-scene]');
  if (!root || !svg) return;
  const stage = $('[data-stage]');
  const P = buildScene(svg);
  const ui = {
    step: $('[data-step]'), hint: $('[data-hint]'), play: $('[data-panel-play]'), done: $('[data-panel-done]'),
    doneHead: $('[data-done-head]'), replay: $('[data-replay]'), announce: $('[data-announce]'),
    hitHandle: $('[data-hit-handle]'), hitWrench: $('[data-hit-wrench]'), sound: $('[data-sound]'), soundLabel: $('[data-sound-label]'),
  };

  const showPanel = (panel, on) => { panel.classList.toggle('is-off', !on); panel.inert = !on; panel.setAttribute('aria-hidden', String(!on)); };

  let S;            // game state, rebuilt by reset()
  let tweens = [];  // {t, dur, ease, from, to, set, done}
  let rafId = 0, last = 0;

  const reset = () => {
    tweens = [];
    queued = false; autoStroking = false; autoTurning = false; drag = null;
    for (const n of [...P.ripples.childNodes]) n.remove();
    for (const n of [...P.drops.querySelectorAll('[data-fall], .splash')]) n.remove();
    S = {
      phase: 'leak',          // leak → closed → wrench → fixed → done
      turn: 0,                // handle turn in degrees: 0 = slightly open, 90 = shut, below 0 = more open
      nut: 0, gap: GAP0,     // nut angle (deg) and how loose it is
      wr: { a: STROKE_FROM, x: 300, y: -26, o: 0, busy: false }, // spanner angle, offset, opacity
      strokes: 0,
      vol: 0.35, wobble: 0,   // hanging drop: volume 0..1 (radius ∝ ∛volume) and wobble clock after a release
      falling: [], ripples: [], splashes: [],
      puddle: 9,
      idleFor: 0, touched: false, wrongWay: false, wrDragged: false,
      clock: 0,
    };
    P.hintHandle.classList.remove('is-on');
    P.hintWrench.classList.remove('is-on');
    P.nutRing.classList.remove('is-on');
    root.dataset.phase = 'leak';
    ui.hitWrench.hidden = true;
    ui.hitHandle.hidden = false;
    showPanel(ui.done, false);
    ui.done.classList.add('is-in-start');
    showPanel(ui.play, true);
    ui.play.classList.remove('is-out');
    ui.announce.textContent = '';
    setCopy(COPY.close, false);
    render();
  };

  /* ---------- copy */
  let copyKey = null;
  function setCopy([step, hint], animate = true) {
    if (copyKey === step + hint) return;
    copyKey = step + hint;
    ui.step.textContent = step;
    ui.hint.textContent = hint;
    if (animate && !reduceMotion.matches) {
      ui.step.classList.remove('is-new');
      void ui.step.offsetWidth;
      ui.step.classList.add('is-new');
    }
  }

  /* ---------- tweens on the game clock */
  function tween(dur, set, { from = 0, to = 1, ease = easeInOut, done, raw = false } = {}) {
    const tw = { t: 0, dur: reduceMotion.matches && !raw ? Math.min(dur, 1) : dur, ease, from, to, set, done };
    tweens.push(tw);
    wake();
    return tw;
  }
  const after = (ms, fn) => tween(ms, () => {}, { done: fn, ease: (t) => t, raw: true });   // a pause, not motion

  /* ---------- the drip, as a function of the repair */
  function dripInterval() {
    if (S.phase === 'leak') {
      const open = clamp(1 - S.turn / 90, 0, 1.4);
      return 2.7 / (1 + 1.9 * open);           // ≈0.93 s at the start, faster if opened, slower as it closes
    }
    if (S.phase === 'closed' || S.phase === 'wrench') {
      const p = S.strokes + clamp((STROKE_FROM - S.wr.a) / (STROKE_FROM - STROKE_TO), 0, 1) * 0.6;
      return 2.2 * (1 + p * 0.75);
    }
    return Infinity;
  }

  /* ---------- simulation */
  function step(dt) {
    S.clock += dt;
    for (const tw of [...tweens]) {
      tw.t += dt * 1000;
      const k = clamp(tw.t / tw.dur, 0, 1);
      tw.set(lerp(tw.from, tw.to, tw.ease(k)));
      if (k >= 1) { tweens.splice(tweens.indexOf(tw), 1); tw.done && tw.done(); }
    }

    // Hanging drop: fed at the leak's rate (volume grows linearly, so it swells fast and then hangs heavy).
    const iv = dripInterval();
    if (Number.isFinite(iv)) {
      S.vol += dt / iv * (0.9 + 0.2 * Math.sin(S.clock * 1.7) * Math.sin(S.clock * 0.61)); // irregular, never erratic
      if (S.vol >= 1) release();
    }
    S.wobble += dt;

    for (const d of [...S.falling]) {
      d.t += dt;
      d.y = d.y0 + 0.5 * GRAV * d.t * d.t;
      if (reduceMotion.matches) {
        d.fade = clamp(d.t / 0.35, 0, 1);
        if (d.fade >= 1) { land(d, true); }
      } else if (d.y >= FLOOR_Y - 3) {
        land(d, false);
      }
    }
    for (const r of [...S.ripples]) { r.t += dt; if (r.t > r.life) { r.node.remove(); S.ripples.splice(S.ripples.indexOf(r), 1); } }
    for (const s of [...S.splashes]) {
      s.t += dt; s.x += s.vx * dt; s.vy += 2400 * dt; s.y += s.vy * dt;
      if (s.y > FLOOR_Y + 2 && s.vy > 0) { s.node.remove(); S.splashes.splice(S.splashes.indexOf(s), 1); }
    }

    // Hints appear only if nobody has tried for a moment, and leave on the first touch.
    S.idleFor += dt;
    if (S.phase === 'leak' && !S.touched && S.idleFor > 1.6) P.hintHandle.classList.add('is-on');
    if (S.phase === 'wrench' && S.strokes === 0 && !S.wrDragged && S.idleFor > 2.2 && !S.wr.busy) P.hintWrench.classList.add('is-on');
  }

  function release() {
    const r = RMAX * Math.cbrt(S.vol);
    const node = el('path', { class: 'drop', 'data-fall': '' }, P.drops);
    S.falling.push({ node, r, y0: TIP.y + r * 1.6, y: TIP.y + r * 1.6, t: 0, fade: 0 });
    S.vol = 0.05;       // the bead left behind, which springs back
    S.wobble = 0;
  }

  function land(d, quiet) {
    d.node.remove();
    S.falling.splice(S.falling.indexOf(d), 1);
    const size = d.r / RMAX;
    S.puddle = Math.min(48, S.puddle + 1.6 * size);
    addRipple(0, 1.15, 0.55 * size);
    if (!quiet) {
      addRipple(0.12, 1.0, 0.3 * size);
      const n = 2 + Math.round(Math.random());
      for (let i = 0; i < n; i++) {
        const dir = i % 2 ? 1 : -1;
        S.splashes.push({ node: el('circle', { class: 'splash', r: f(0.9 + Math.random() * 0.7) }, P.drops), x: TIP.x + dir * 2, y: FLOOR_Y - 2, vx: dir * (26 + Math.random() * 46), vy: -(120 + Math.random() * 90), t: 0 });
      }
    }
    Sound.drip(0.8 + 0.4 * size);
  }

  function addRipple(delay, life, strength) {
    const node = el('ellipse', { class: 'ripple', cx: TIP.x, cy: FLOOR_Y, rx: 0, ry: 0, opacity: 0 }, P.ripples);
    S.ripples.push({ node, t: -delay, life, strength });
  }

  /* ---------- drawing */
  function render() {
    // Handle
    const turn = rad(S.turn);
    const bases = [45, 135, 225, 315].map(rad);
    P.arms.forEach((arm, i) => {
      const a = bases[i] - turn;               // closing turns the front of the handle to the right
      for (const L of arm.layers) L.node.setAttribute('transform', planeMatrix(a, CX, HANDLE_Y + L.dy));
      arm.glint.setAttribute('transform', planeMatrix(a, CX, HANDLE_Y));
      arm.depth = Math.sin(a);
    });
    // painter's order: arms behind the hub first, the nearest arm last
    const order = [...P.arms].sort((p, q) => p.depth - q.depth);
    const key = order.map((a) => P.arms.indexOf(a) + (a.depth > 0 ? 'f' : 'b')).join('');
    if (key !== P.armOrder) {
      P.armOrder = key;
      for (const a of order) (a.depth > 0 ? P.armsFront : P.armsBack).appendChild(a.g);
    }
    const ca = rad(-60) - turn;
    P.capMark.setAttribute('d', `M${f(CX + 3 * Math.cos(ca))} ${f(254 + 3 * K * Math.sin(ca))}L${f(CX + 10 * Math.cos(ca))} ${f(254 + 10 * K * Math.sin(ca))}`);

    // Nut
    const top = NUT_SEAT - NUT_H - S.gap;
    const pt = (a, y) => [CX + NUT_R * Math.cos(a), y + K * NUT_R * Math.sin(a)];
    const light = [-0.55, 0.83];
    for (let j = 0; j < 6; j++) {
      const a1 = rad(S.nut + j * 60), a2 = rad(S.nut + j * 60 + 60), an = rad(S.nut + j * 60 + 30);
      const face = P.nutFaces[j];
      if (Math.sin(an) <= 0.02) { face.setAttribute('d', ''); continue; }
      const [x1, y1] = pt(a1, top), [x2, y2] = pt(a2, top);
      const lam = clamp(Math.cos(an) * light[0] + Math.sin(an) * light[1], 0, 1);
      const shade = mix('#2C3035', '#E9EBE7', 0.12 + 0.88 * Math.pow(lam, 1.6));
      face.setAttribute('d', `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}L${f(x2)} ${f(y2 + NUT_H)}L${f(x1)} ${f(y1 + NUT_H)}Z`);
      face.setAttribute('fill', shade);
      face.setAttribute('stroke', mix('#2C3035', '#FFFFFF', 0.3 + 0.5 * lam));
      face.setAttribute('stroke-width', '.6');
    }
    P.nutTop.setAttribute('d', [0, 1, 2, 3, 4, 5].map((j) => pt(rad(S.nut + j * 60), top)).map(([x, y], j) => `${j ? 'L' : 'M'}${f(x)} ${f(y)}`).join('') + 'Z');
    P.nutChamfer.setAttribute('cx', CX); P.nutChamfer.setAttribute('cy', f(top));
    P.nutChamfer.setAttribute('rx', 30); P.nutChamfer.setAttribute('ry', f(30 * K));
    P.neck.setAttribute('d', `M${CX - 13} ${HANDLE_Y + 8}V${f(top)}A13 ${f(13 * K)} 0 0 0 ${CX + 13} ${f(top)}V${HANDLE_Y + 8}Z`);

    // Spanner
    const w = S.wr;
    const wa = rad(w.a);
    for (const L of P.wrenchLayers) L.node.setAttribute('transform', planeMatrix(wa, CX + w.x, WRENCH_Y + w.y + L.dy));
    P.wrench.setAttribute('opacity', f(w.o));
    const plane = WRENCH_Y + w.y;
    P.clipBack.setAttribute('height', f(plane));
    P.clipFront.setAttribute('y', f(plane));

    // Hanging drop, with a damped wobble after each release
    const r = RMAX * Math.cbrt(clamp(S.vol, 0, 1));
    const wob = reduceMotion.matches ? 0 : 0.22 * Math.exp(-7 * S.wobble) * Math.sin(S.wobble * 34);
    if (r < 0.6) { P.hang.setAttribute('d', ''); P.hangGlint.setAttribute('rx', 0); }
    else {
      const neck = Math.min(4, 1.2 + r * 0.45);
      const c = r * (1.05 + 0.15 * clamp(S.vol, 0, 1)) * (1 + wob);
      P.hang.setAttribute('d', `M${-neck} 0C${-neck} ${f(c * 0.3)} ${f(-r)} ${f(c - r * 0.5)} ${f(-r)} ${f(c)}A${f(r)} ${f(r)} 0 1 0 ${f(r)} ${f(c)}C${f(r)} ${f(c - r * 0.5)} ${neck} ${f(c * 0.3)} ${neck} 0Z`);
      P.hangGlint.setAttribute('cx', f(TIP.x - r * 0.38)); P.hangGlint.setAttribute('cy', f(TIP.y + c - r * 0.3));
      P.hangGlint.setAttribute('rx', f(r * 0.17)); P.hangGlint.setAttribute('ry', f(r * 0.24));
    }

    for (const d of S.falling) {
      const v = GRAV * d.t;
      const sy = 1 + Math.min(0.3, v * 0.00045), sx = 1 / Math.sqrt(sy);
      const rx = d.r * sx, ry = d.r * sy;
      d.node.setAttribute('d', `M0 ${f(-ry * 1.25)}C${f(rx * 0.45)} ${f(-ry * 0.7)} ${f(rx)} ${f(-ry * 0.25)} ${f(rx)} ${f(ry * 0.15)}A${f(rx)} ${f(ry * 0.85)} 0 0 1 ${f(-rx)} ${f(ry * 0.15)}C${f(-rx)} ${f(-ry * 0.25)} ${f(-rx * 0.45)} ${f(-ry * 0.7)} 0 ${f(-ry * 1.25)}Z`);
      d.node.setAttribute('transform', `translate(${TIP.x} ${f(reduceMotion.matches ? d.y0 : d.y)})`);
      if (reduceMotion.matches) d.node.setAttribute('opacity', f(1 - d.fade));
    }
    for (const rp of S.ripples) {
      const k = clamp(rp.t / rp.life, 0, 1);
      const rr = 3 + 40 * easeOut(k);
      rp.node.setAttribute('rx', f(rr)); rp.node.setAttribute('ry', f(rr * K));
      rp.node.setAttribute('opacity', rp.t < 0 ? 0 : f(rp.strength * Math.pow(1 - k, 1.6)));
    }
    for (const s of S.splashes) { s.node.setAttribute('cx', f(s.x)); s.node.setAttribute('cy', f(s.y)); }
    P.puddle.setAttribute('rx', f(S.puddle)); P.puddle.setAttribute('ry', f(S.puddle * K));
  }

  /* ---------- loop: runs while anything moves, sleeps when the job is done and the water is still */
  function frame(now) {
    rafId = 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    render();
    const settled = S.phase === 'done' && !tweens.length && !S.falling.length && !S.ripples.length && !S.splashes.length;
    if (!settled) rafId = requestAnimationFrame(frame);
  }
  function wake() { if (!rafId) { last = performance.now(); rafId = requestAnimationFrame(frame); } }

  /* ---------- step 1: the handle */
  function setTurn(t, fromUser) {
    if (S.phase !== 'leak') return;
    S.turn = clamp(t, -28, 90);
    if (fromUser) { S.touched = true; S.idleFor = 0; P.hintHandle.classList.remove('is-on'); }
    if (S.turn < -6 && !S.wrongWay) { S.wrongWay = true; setCopy(COPY.wrongWay); }
    if (S.turn > 10 && S.wrongWay) { S.wrongWay = false; setCopy(COPY.close); }
    if (S.turn >= 88.5) shutHandle();
  }
  function shutHandle() {
    S.turn = 90;
    S.phase = 'closed';
    root.dataset.phase = 'closed';
    drag = null;
    Sound.play('stop', 0.9);
    // the drop that is hanging now still falls: it was already through the valve
    after(900, () => {
      setCopy(COPY.stillDrips);
      const handleHadFocus = document.activeElement === ui.hitHandle;
      ui.hitHandle.hidden = true;
      ui.hitWrench.hidden = false;
      if (handleHadFocus) ui.hitWrench.focus({ preventScroll: true });
      P.nutRing.classList.remove('is-on'); void P.nutRing.getBBox(); P.nutRing.classList.add('is-on');
      S.wr.busy = true;
      S.phase = 'wrench';
      root.dataset.phase = 'wrench';
      S.idleFor = 0;
      tween(620, (k) => { S.wr.x = lerp(300, 0, k); S.wr.y = lerp(-26, -8, k); S.wr.o = clamp(k * 2.2, 0, 1); }, { ease: easeOut, done: () => {
        tween(160, (k) => { S.wr.y = lerp(-8, 0, k); }, { ease: easeIn, done: () => { S.wr.busy = false; Sound.play('seat', 0.8); if (queued) { queued = false; autoStroke(); } } });
      } });
    });
  }
  function autoTurn() {
    if (S.phase !== 'leak' || autoTurning) return;
    autoTurning = true;
    S.touched = true; P.hintHandle.classList.remove('is-on');
    Sound.play('grip', 0.5);
    const from = S.turn;
    tween(620 * (90 - from) / 90 + 120, (v) => setTurn(v, false), { from, to: 90, ease: easeInOut, done: () => { autoTurning = false; } });
  }
  let autoTurning = false;

  /* ---------- step 2: the spanner */
  function setStroke(a) {
    if (S.phase !== 'wrench' || S.wr.busy) return;
    S.idleFor = 0;
    const prev = S.wr.a;
    S.wr.a = clamp(a, STROKE_TO, Math.max(prev, STROKE_TO));    // the nut only turns one way: it never loosens
    const moved = prev - S.wr.a;
    if (moved > 0) P.nutRing.classList.remove('is-on');
    S.nut -= moved;
    S.gap = Math.max(0, S.gap - (moved / (STROKE_FROM - STROKE_TO)) * (GAP0 / STROKES));
    if (S.wr.a <= STROKE_TO + 0.5) finishStroke();
  }
  function finishStroke() {
    S.wr.a = STROKE_TO;
    S.wr.busy = true;
    drag = null;
    S.strokes += 1;
    S.gap = GAP0 * (1 - S.strokes / STROKES);
    Sound.play('click', 0.9);
    if (S.strokes >= STROKES) return fix();
    setCopy(S.strokes === 1 ? COPY.stroke1 : COPY.stroke2);
    // lift the spanner off, swing it back, seat it on the next pair of flats
    tween(110, (k) => { S.wr.y = lerp(0, -9, k); }, { ease: easeOut, done: () => {
      tween(340, (k) => { S.wr.a = lerp(STROKE_TO, STROKE_FROM, k); }, { ease: easeInOut, done: () => {
        tween(110, (k) => { S.wr.y = lerp(-9, 0, k); }, { ease: easeIn, done: () => {
          S.wr.busy = false;
          Sound.play('seat', 0.7);
          if (queued) { queued = false; autoStroke(); }   // a tap made during the swing back is not lost
        } });
      } });
    } });
  }
  let autoStroking = false, queued = false;
  function autoStroke() {
    if (S.phase === 'wrench' && (S.wr.busy || autoStroking)) { queued = true; return; }   // one tap can wait its turn
    if (S.phase !== 'wrench' || S.wr.busy || autoStroking) return;
    autoStroking = true;
    S.wrDragged = true; P.hintWrench.classList.remove('is-on');
    Sound.play('grip', 0.35);
    const from = S.wr.a;
    tween(460 * (from - STROKE_TO) / 60 + 80, (v) => setStroke(v), { from, to: STROKE_TO, ease: easeInOut, done: () => { autoStroking = false; } });
  }

  /* ---------- the end */
  function fix() {
    S.phase = 'fixed';
    root.dataset.phase = 'fixed';
    P.hintWrench.classList.remove('is-on');
    P.nutRing.classList.remove('is-on');
    // the bead at the spout draws back in; nothing more comes through
    const v0 = S.vol;
    tween(700, (k) => { S.vol = lerp(v0, 0, k); }, { ease: easeOut });
    tween(160, (k) => { S.wr.y = lerp(0, -10, k); }, { ease: easeOut, done: () => {
      tween(520, (k) => { S.wr.x = lerp(0, 320, k); S.wr.o = 1 - clamp((k - 0.4) / 0.6, 0, 1); }, { ease: easeIn });
    } });
    after(1100, () => {
      S.phase = 'done';
      root.dataset.phase = 'done';
      const hadFocus = document.activeElement === ui.hitWrench;
      ui.hitWrench.hidden = true;
      ui.play.classList.add('is-out');
      showPanel(ui.done, true);
      ui.done.classList.add('is-in-start');
      ui.announce.textContent = 'U kry. S’ka ma pikim.';
      void ui.done.offsetWidth;
      ui.done.classList.remove('is-in-start');
      Sound.play('mark', 0.85);
      after(reduceMotion.matches ? 1 : 360, () => showPanel(ui.play, false));
      if (hadFocus) ui.doneHead.focus({ preventScroll: true });
      // on short phones the result sits under the tap: bring it into view if it starts off screen
      const box = ui.done.getBoundingClientRect();
      if (box.bottom > innerHeight) ui.done.scrollIntoView({ block: 'end', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    });
  }

  /* ---------- input: drag (mouse, pen, touch), tap and keyboard all drive the same functions */
  let drag = null;
  const toSvgX = (clientX) => {
    const m = svg.getScreenCTM();
    return m ? (clientX - m.e) / m.a : clientX;
  };
  function bindHit(btn, kind) {
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (kind === 'handle' && (S.phase !== 'leak' || autoTurning))) return;
      if (kind === 'wrench' && (S.phase !== 'wrench' || S.wr.busy || autoStroking)) { autoStroke(); return; }
      try { btn.setPointerCapture(e.pointerId); } catch {}
      drag = { kind, id: e.pointerId, x0: toSvgX(e.clientX), y0: e.clientY, start: kind === 'handle' ? S.turn : S.wr.a, moved: 0 };
      stage.classList.add('is-dragging');
      if (kind === 'handle') { S.touched = true; P.hintHandle.classList.remove('is-on'); }
      else { S.wrDragged = true; P.hintWrench.classList.remove('is-on'); }
      Sound.play('grip', 0.35);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = toSvgX(e.clientX) - drag.x0;
      drag.moved = Math.max(drag.moved, Math.abs(dx));
      S.idleFor = 0;
      if (kind === 'handle') setTurn(drag.start + dx * (90 / 118), true);   // a quarter turn ≈ the arm's travel
      else setStroke(drag.start - dx * (60 / 170));                        // the spanner's end follows the finger
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const wasTap = drag.moved < 6;
      drag = null;
      stage.classList.remove('is-dragging');
      if (wasTap) (kind === 'handle' ? autoTurn : autoStroke)();
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', (e) => { if (drag && drag.id === e.pointerId) { drag = null; stage.classList.remove('is-dragging'); } });
    // Enter and Space arrive as click without a pointer; pointer taps are handled above.
    btn.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      (kind === 'handle' ? autoTurn : autoStroke)();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (kind === 'handle' && S.phase === 'leak' && !autoTurning) { S.touched = true; setTurn(S.turn + dir * 15, true); }
      if (kind === 'wrench' && dir > 0 && !autoStroking) { S.wrDragged = true; P.hintWrench.classList.remove('is-on'); setStroke(S.wr.a - 15); }
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindHit(ui.hitHandle, 'handle');
  bindHit(ui.hitWrench, 'wrench');

  ui.replay.addEventListener('click', () => {
    reset();
    wake();
    ui.hitHandle.focus({ preventScroll: true });
  });

  /* ---------- sound switch: off until the visitor turns it on */
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

  document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });
  reduceMotion.addEventListener?.('change', () => render());

  reset();
  wake();
}

mountGame();
