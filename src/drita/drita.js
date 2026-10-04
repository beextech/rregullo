// "Drita": something is broken, you fix it, the light comes back on, Rregullo appears.
// Turn the burnt bulb out of its socket, bring the new one up, turn it in, and the room lights up around the logo.
// Turning: swipe across the bulb (left takes it out, right puts it in), tap it for a quarter turn, or use the arrow keys.
// One requestAnimationFrame loop drives the bulbs, the swinging fixture and the light; it sleeps when nothing moves.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Geometry, in the scene's own units (viewBox 70 20 260 470). A bulb's origin is the top of its screw base.
const SEAT = { x: 200, y: 170 };   // the bulb fully screwed in
const REST = { x: 290, y: 352 };   // where the new bulb waits, within reach
const PIVOT = { x: 200, y: -20 };  // the fixture hangs (and swings) from above the top edge
const TURNS = 540;                 // degrees from first thread to seated: a turn and a half
const PITCH = 8;                   // units the bulb travels per full turn
const TIGHT = 80;                  // the last degrees before it seats turn stiffer
const GLASS_Y = 77;                // centre of the glass, in bulb units
const NEAR = 84;                   // how close the new bulb has to be to the socket to drop into it
const DEG = Math.PI / 180;

const COPY = {
  unscrew: 'Kape llambën dhe rrotulloje majtas.',
  unscrewWrong: 'Majtas, jo djathtas.',
  almostOut: 'Edhe pak…',
  fetch: 'Çoje llambën e re te mbajtësja.',
  screw: 'Tani rrotulloje djathtas, deri në fund.',
  screwWrong: 'Djathtas, jo majtas.',
  almostIn: 'Edhe pak…',
};
const LABEL = {
  old: 'Llamba e djegur. Rrotulloje majtas me shigjetën majtas, ose shtyp Enter.',
  carry: 'Llamba e re. Shtyp Enter për ta vendosur te mbajtësja.',
  screw: 'Llamba e re, te mbajtësja. Rrotulloje djathtas me shigjetën djathtas, ose shtyp Enter.',
};

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = (n) => Math.round(n * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(-2 * t + 2, 3) / 2),
  linear: (t) => t,
};

/* ---------------------------------------------------------------- sound (opt-in, brand Foley library + a few synthesized ticks) */

const Sound = {
  on: false, ctx: null, out: null, buffers: {}, loading: null, noise: null, hum: null,
  files: { grip: 'grip', seat: 'wrench-seat', mark: 'sonic-mark' },
  async enable() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.out = this.ctx.createGain();
        this.out.gain.value = 0.9;
        this.out.connect(this.ctx.destination);
        // a short buffer of noise for the thread ticks and the filament's crackle
        const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.12, this.ctx.sampleRate);
        const d = n.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noise = n;
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
  disable() { this.on = false; this.humOff(0); if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); },
  play(key, gain = 1, delay = 0) {
    if (!this.on || !this.ctx || !this.buffers[key]) return;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = this.buffers[key];
    src.connect(g).connect(this.out);
    src.start(this.ctx.currentTime + delay);
  },
  // a burst of filtered noise: thread ticks (high, short) and filament crackle (lower, rougher)
  burst(freq, q, gain, len) {
    if (!this.on || !this.ctx || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const bp = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.05, len + 0.02);
  },
  tick() { this.burst(2600 + Math.random() * 600, 2.5, 0.16, 0.03); },
  crackle() { this.burst(1400, 0.8, 0.22, 0.05); },
  // glass meeting the hand: two quick partials
  clink() {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [freq, gain] of [[2950, 0.05], [4420, 0.025]]) {
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.4);
    }
  },
  // the mains hum of a bulb coming on, barely there and gone again
  humOn() {
    if (!this.on || !this.ctx || this.hum) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    g.connect(this.out);
    const oscs = [100, 200].map((fr, i) => {
      const o = this.ctx.createOscillator(); const og = this.ctx.createGain();
      o.frequency.value = fr; og.gain.value = i ? 0.35 : 1;
      o.connect(og).connect(g); o.start(t); o.stop(t + 2.3);
      return o;
    });
    this.hum = { g, oscs };
    setTimeout(() => { this.hum = null; }, 2400);
  },
  humOff() {
    if (!this.hum) return;
    try { this.hum.oscs.forEach((o) => o.stop()); } catch {}
    this.hum = null;
  },
};

const buzz = (ms) => { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } };

/* ---------------------------------------------------------------- the game */

function mountGame() {
  const root = $('[data-drita]');
  if (!root) return;
  const page = document.body;
  const scene = $('[data-scene]');
  const ui = {
    stage: $('[data-stage]'), fixture: $('[data-fixture]'), fixtureLit: $('[data-fixture-lit]'),
    halo: $('[data-halo]'), logo: $('[data-logo]'), reveal: $('[data-reveal]'),
    arc: $('[data-arc]'), target: $('[data-target]'), shadow: $('[data-shadow]'),
    hint: $('[data-hint]'), announce: $('[data-announce]'), doneHead: $('[data-done-head]'), replay: $('[data-replay]'),
    sound: $('[data-sound]'), soundLabel: $('[data-sound-label]'),
    panels: Object.fromEntries([...document.querySelectorAll('[data-panel]')].map((p) => [p.dataset.panel, p])),
  };

  // Both bulbs share one shape; each keeps its own place, turn and light.
  const makeBulb = (el, broken) => ({
    el, broken,
    threads: $('[data-threads]', el), strands: [...el.querySelectorAll('[data-strands] path')],
    litGlass: $('[data-lit-glass]', el), bloom: $('[data-bloom]', el), spark: $('[data-spark]', el), hit: $('[data-hit]', el),
    mode: 'socket',            // 'socket': hangs in the fixture at turn p; 'free': at x, y, tilted by rot
    p: 0, x: SEAT.x, y: SEAT.y, rot: 0, opacity: 1, L: 0, flick: 0,
  });
  const old = makeBulb($('[data-bulb="old"]'), true);
  const neu = makeBulb($('[data-bulb="new"]'), false);

  const S = {
    phase: 'unscrew',          // unscrew → drop → fetch → place → screw → light → done (→ reset → unscrew)
    pRaw: 0,                   // the turn the hand asks for; the bulb shows it with a soft stop at either end
    sway: { a: 0, v: 0 }, bounce: { y: 0, v: 0 },
    tweens: [], drag: null, carry: null, bob: 0,
    reveal: 0, logo: 0,
    lastTick: 0, hintKey: 'unscrew',
  };
  let gen = 0;
  // focus follows the bulb only for keyboard players; a finger or a mouse never gets a focus ring it didn't ask for
  let keyboard = false;
  addEventListener('keydown', (e) => { if (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow')) keyboard = true; }, true);
  addEventListener('pointerdown', () => { keyboard = false; }, true);   // bumps on replay: anything still waiting from the last round quietly stops

  /* -------- drawing */

  const OFF = [122, 101, 72], ON = [255, 244, 214];
  const strandColor = (L) => `rgb(${OFF.map((c, i) => Math.round(lerp(c, ON[i], L))).join(',')})`;

  // The filaments: four strands in a cage around the stem. Turning the bulb turns them, so you can see it turn.
  function drawStrands(b, theta) {
    const L = Math.max(b.L, b.flick * 0.55);
    b.strands.forEach((path, i) => {
      const a = (theta + 20 + i * 90) * DEG;
      const s = Math.sin(a), z = Math.cos(a);
      const top = [3.2 * s, 58], bot = [16 * s, 98];
      const at = (t) => [lerp(top[0], bot[0], t), lerp(top[1], bot[1], t)];
      let d;
      if (b.broken && i === 0) {
        // the burnt strand: snapped, its lower half hanging loose from the bottom wire, curled at the break
        const p1 = at(0.4), p2 = at(0.64);
        const dx = 4 * Math.cos(a);
        d = `M${f(top[0])} ${top[1]}L${f(p1[0])} ${f(p1[1])}M${f(p2[0] + dx)} ${f(p2[1] + 2)}Q${f(p2[0] + dx * 1.6)} ${f(p2[1] + 8)} ${f(lerp(p2[0], bot[0], 0.5))} ${f(lerp(p2[1], bot[1], 0.5) + 2)}L${f(bot[0])} ${bot[1]}`;
        if (b.spark) b.spark.setAttribute('transform', `translate(${f((p1[0] + p2[0]) / 2)} ${f((p1[1] + p2[1]) / 2)})`);
      } else {
        d = `M${f(top[0])} ${top[1]}L${f(bot[0])} ${bot[1]}`;
      }
      path.setAttribute('d', d);
      path.setAttribute('stroke', strandColor(b.broken && i === 0 ? b.flick * 0.2 : L));
      path.setAttribute('stroke-opacity', f(lerp(0.32 + 0.68 * (z + 1) / 2, 1, L)));
    });
  }

  function drawBulb(b) {
    // in the socket the bulb sits lower the further it is turned out, and swings with the fixture
    const theta = b.mode === 'socket' ? -b.p : b.rot * 4;
    if (b.mode === 'socket') {
      const y = b.y + (b.p / 360) * PITCH + S.bounce.y;
      b.el.setAttribute('transform', `rotate(${f(S.sway.a)} ${PIVOT.x} ${PIVOT.y}) translate(${f(b.x)} ${f(y)})`);
    } else {
      b.el.setAttribute('transform', `translate(${f(b.x)} ${f(b.y)}) rotate(${f(b.rot)} 0 ${GLASS_Y})`);
    }
    b.el.setAttribute('opacity', f(b.opacity));
    // the thread is a helix: as the bulb turns, its ridges travel along the base
    const off = ((((b.mode === 'socket' ? -b.p : 0) / 360) * PITCH) % 6.5 + 6.5) % 6.5;
    b.threads.setAttribute('transform', `translate(0 ${f(off - 6.5)})`);
    drawStrands(b, theta);
    b.litGlass.setAttribute('opacity', f(b.L * 0.92));
    b.bloom.setAttribute('opacity', f(Math.max(b.L, b.flick * 0.3)));
    if (b.spark) b.spark.setAttribute('opacity', f(b.flick));
  }

  function draw() {
    ui.fixture.setAttribute('transform', `rotate(${f(S.sway.a)} ${PIVOT.x} ${PIVOT.y}) translate(0 ${f(S.bounce.y)})`);
    ui.halo.setAttribute('transform', `rotate(${f(S.sway.a)} ${PIVOT.x} ${PIVOT.y})`);
    drawBulb(old);
    drawBulb(neu);
    ui.halo.setAttribute('opacity', f(neu.L));
    ui.fixtureLit.setAttribute('opacity', f(neu.L));
    ui.reveal.setAttribute('r', f(S.reveal));
    ui.logo.setAttribute('opacity', f(S.logo));
    // the guide arc follows whichever bulb is in the socket
    const inSocket = S.phase === 'screw' ? neu : old;
    ui.arc.setAttribute('transform', `rotate(${f(S.sway.a)} ${PIVOT.x} ${PIVOT.y}) translate(0 ${f(SEAT.y + (inSocket.p / 360) * PITCH + 66)})${S.phase === 'screw' ? ' matrix(-1 0 0 1 400 0)' : ''}`);
    // the new bulb's shadow on the floor, softer the higher it is lifted
    const lift = clamp((REST.y - neu.y) / 200, 0, 1);
    ui.shadow.setAttribute('cx', f(neu.x));
    ui.shadow.setAttribute('rx', f(27 * (1 + lift * 0.6)));
    ui.shadow.setAttribute('opacity', f(neu.mode === 'free' ? neu.opacity * 0.5 * (1 - lift) : 0));
  }

  /* -------- the loop */

  const tween = (dur, apply, curve = ease.out) => new Promise((resolve) => {
    if (dur <= 0) { apply(1); resolve(); return; }
    S.tweens.push({ t: 0, dur, apply, curve, resolve });
    run();
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let raf = 0, last = 0, inFrame = false;
  const springsAwake = () => Math.abs(S.sway.a) > 0.01 || Math.abs(S.sway.v) > 0.01 || Math.abs(S.bounce.y) > 0.02 || Math.abs(S.bounce.v) > 0.02;
  function frame(now) {
    raf = 0;
    inFrame = true;
    const dt = clamp((now - last) / 1000 || 0, 0, 0.05);   // rAF time can trail performance.now(): never step backwards
    last = now;

    for (const tw of [...S.tweens]) {
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      tw.apply(tw.curve(tw.t), tw.t);
      if (tw.t >= 1) { S.tweens.splice(S.tweens.indexOf(tw), 1); tw.resolve(); }
    }
    // the fixture: a pendulum that swings a little and settles; the cord gives a little when the weight changes
    if (!reduceMotion.matches) {
      for (let i = 0; i < 4; i++) {
        const h = dt / 4;
        S.sway.v += (-70 * S.sway.a - 4.2 * S.sway.v) * h; S.sway.a += S.sway.v * h;
        S.bounce.v += (-260 * S.bounce.y - 10 * S.bounce.v) * h; S.bounce.y += S.bounce.v * h;
      }
      S.sway.a = clamp(S.sway.a, -3, 3);
    } else { S.sway.a = 0; S.bounce.y = 0; }

    // the new bulb follows the hand with a little lag, and leans the way it is moving
    if (S.carry) {
      const k = Math.min(1, dt * 24);
      const nx = lerp(neu.x, S.carry.x, k), ny = lerp(neu.y, S.carry.y, k);
      const vx = (nx - neu.x) / Math.max(dt, 0.001);
      neu.rot = lerp(neu.rot, clamp(vx * 0.035, -16, 16), Math.min(1, dt * 10));
      neu.x = nx; neu.y = ny;
      ui.target.classList.toggle('is-near', nearSocket());
    } else if (S.phase === 'fetch' && !reduceMotion.matches && !S.tweens.length) {
      // waiting within reach: a slow breath, as if held out in an open hand
      S.bob += dt;
      neu.y = REST.y + Math.sin(S.bob * 1.6) * 2.2;
      neu.rot = Math.sin(S.bob * 0.9) * 1.2;
    }

    draw();
    const busy = S.tweens.length || S.carry || S.drag || springsAwake() || (S.phase === 'fetch' && !reduceMotion.matches);
    inFrame = false;
    if (busy && !document.hidden) raf = requestAnimationFrame(frame);
  }
  // anything that changes the scene calls run(); inside a frame the frame itself decides whether to go on
  const run = () => { if (!raf && !inFrame) { last = performance.now(); raf = requestAnimationFrame(frame); } };

  /* -------- words */

  const say = (text) => { ui.announce.textContent = ''; requestAnimationFrame(() => { ui.announce.textContent = text; }); };
  const hint = (key, announce = false) => {
    if (S.hintKey === key) return;
    S.hintKey = key;
    ui.hint.textContent = key ? COPY[key] : ' ';
    ui.hint.classList.remove('is-new'); void ui.hint.offsetWidth; ui.hint.classList.add('is-new');
    if (announce && key) say(COPY[key]);
  };
  const showPanel = (name) => {
    for (const [key, p] of Object.entries(ui.panels)) {
      const on = key === name;
      p.classList.toggle('is-off', !on);
      p.setAttribute('aria-hidden', String(!on));
      p.inert = !on;
    }
  };
  const setPhase = (phase) => { S.phase = phase; root.dataset.phase = phase; };
  const activate = (b, label) => {
    for (const x of [old, neu]) {
      const on = x === b;
      x.hit.classList.toggle('is-active', on);
      x.hit.setAttribute('tabindex', on ? '0' : '-1');
      if (on && label) x.hit.setAttribute('aria-label', label);
    }
  };

  /* -------- turning */

  // How far the bulb shows itself turned: past either end it gives a little, like a thread that won't go further
  const soft = (raw) => (raw < 0 ? -18 * (1 - Math.exp(raw / 18)) : raw > TURNS ? TURNS + 18 * (1 - Math.exp(-(raw - TURNS) / 18)) : raw);
  const turning = () => (S.phase === 'unscrew' ? old : S.phase === 'screw' ? neu : null);

  function setTurn(raw) {
    const b = turning();
    if (!b) return;
    S.pRaw = raw;
    b.p = soft(raw);
    // a tick every eighth of a turn: heard, and felt where phones can
    const tick = Math.floor(clamp(b.p, 0, TURNS) / 45);
    if (tick !== S.lastTick) { S.lastTick = tick; Sound.tick(); buzz(4); }
    if (S.phase === 'unscrew') {
      if (raw < -6) hint('unscrewWrong');
      else if (raw > TURNS - 120) hint('almostOut');
      else if (raw > 20) hint('unscrew');
      if (raw >= TURNS) released();
    } else {
      if (raw > TURNS + 6) hint('screwWrong');
      else if (raw < TIGHT + 40) hint('almostIn');
      else hint('screw');
      if (raw <= 0) seated();
    }
    run();
  }
  // a turn in degrees, positive = out (left). Near the seat the thread turns stiffer.
  const turnBy = (deg) => {
    const k = S.phase === 'screw' && S.pRaw < TIGHT && deg < 0 ? 0.6 : 1;
    setTurn(S.pRaw + deg * k);
  };
  // a tap or Enter: a quarter turn the right way
  const quarter = async () => {
    const b = turning();
    if (!b || S.quarter) return;
    S.quarter = true;
    const from = S.pRaw;
    const to = S.phase === 'unscrew' ? Math.min(TURNS, from + 90) : Math.max(0, from - 90);
    S.sway.v += (S.phase === 'unscrew' ? -1 : 1) * 6;
    await tween(reduceMotion.matches ? 0.12 : 0.3, (e) => { if (turning() === b) setTurn(lerp(from, to, e)); });
    S.quarter = false;
  };
  const springBack = () => {
    const from = S.pRaw;
    const to = clamp(from, 0, TURNS);
    if (from === to) return;
    tween(0.35, (e) => setTurn(lerp(from, to, e)));
  };

  /* -------- the round */

  async function released() {
    const g = gen;
    setPhase('drop');
    activate(null);
    ui.arc.classList.remove('is-on');
    hint(null);
    S.pRaw = TURNS; old.p = TURNS;
    Sound.clink(); buzz(10);
    S.bounce.v -= 60;                        // the cord lifts as the weight comes off
    // out of the thread it drops into the hand, then is set aside
    old.mode = 'free'; old.x = SEAT.x; old.y = SEAT.y + (TURNS / 360) * PITCH; old.rot = 0;
    const quick = reduceMotion.matches;
    const y0 = old.y;
    await tween(quick ? 0 : 0.16, (e) => { old.y = y0 + 10 * e; }, ease.in);
    if (g !== gen) return;
    const x1 = old.x, y1 = old.y;
    tween(quick ? 0.2 : 0.75, (e, t) => {
      old.x = lerp(x1, 110, quick ? 0 : e); old.y = lerp(y1, 560, quick ? 0 : e);
      old.rot = -38 * e; old.opacity = 1 - (quick ? t : clamp((t - 0.35) / 0.65, 0, 1));
    }, ease.in);
    await wait(quick ? 120 : 380);
    if (g !== gen) return;
    // the new bulb comes up within reach
    neu.mode = 'free'; neu.x = REST.x; neu.rot = 0; neu.L = 0; neu.p = TURNS;
    await tween(quick ? 0.2 : 0.7, (e, t) => { neu.y = REST.y + (quick ? 0 : 70 * (1 - e)); neu.opacity = quick ? t : clamp(t * 1.6, 0, 1); });
    if (g !== gen) return;
    S.bob = 0;
    setPhase('fetch');
    activate(neu, LABEL.carry);
    ui.target.classList.add('is-on');
    hint('fetch', true);
    if (keyboard && document.activeElement === old.hit) neu.hit.focus({ preventScroll: true });
    run();
  }

  const attachAt = () => ({ x: SEAT.x, y: SEAT.y + (TURNS / 360) * PITCH });
  function nearSocket() {
    const a = attachAt();
    return Math.hypot(neu.x - a.x, neu.y - a.y) < NEAR;
  }

  async function place() {
    if (S.phase !== 'fetch') return;
    const g = gen;
    setPhase('place');
    S.carry = null;
    activate(null);
    ui.target.classList.add('is-near');
    const a = attachAt();
    const x0 = neu.x, y0 = neu.y, r0 = neu.rot;
    // into the socket mouth: straight up the last bit, the way a hand guides it in
    await tween(reduceMotion.matches ? 0.15 : 0.5, (e) => {
      neu.x = lerp(x0, a.x, e); neu.y = lerp(y0, a.y + 6, e); neu.rot = lerp(r0, 0, e);
    }, ease.inOut);
    if (g !== gen) return;
    await tween(reduceMotion.matches ? 0 : 0.14, (e) => { neu.y = a.y + 6 * (1 - e); }, ease.out);
    if (g !== gen) return;
    ui.target.classList.remove('is-on', 'is-near');
    neu.mode = 'socket'; neu.x = SEAT.x; neu.y = SEAT.y; neu.rot = 0; neu.p = TURNS;
    S.pRaw = TURNS; S.lastTick = Math.floor(TURNS / 45);
    Sound.play('grip', 0.6); buzz(8);
    S.sway.v += 9; S.bounce.v += 30;        // the weight is back on the cord
    setPhase('screw');
    activate(neu, LABEL.screw);
    ui.arc.classList.add('is-on');
    hint('screw', true);
    if (keyboard) neu.hit.focus({ preventScroll: true });
    run();
  }

  // The flicker as the contact makes: a few uneven catches, then it holds and warms up. Times in seconds.
  const FLICKER = [[0, 0], [0.05, 0.55], [0.1, 0.04], [0.2, 0], [0.24, 0.78], [0.3, 0.12], [0.39, 0.92], [0.44, 0.38], [0.52, 0.42]];
  const flickerAt = (t) => {
    let v = 0;
    for (const [at, val] of FLICKER) if (t >= at) v = val;
    if (t > 0.52) v = lerp(0.42, 1, ease.out(clamp((t - 0.52) / 0.6, 0, 1)));
    return v;
  };

  async function seated() {
    const g = gen;
    setPhase('light');
    S.pRaw = 0; neu.p = 0;
    activate(null);
    ui.arc.classList.remove('is-on');
    hint(null);
    Sound.play('seat', 0.8); buzz(14);
    S.sway.v -= 7;
    await wait(reduceMotion.matches ? 120 : 260);
    if (g !== gen) return;

    // 1. the contact makes: it catches, flickers, holds
    if (reduceMotion.matches) {
      await tween(0.35, (e) => { neu.L = e; }, ease.linear);
    } else {
      let catches = 0;
      Sound.humOn();
      await tween(1.15, (e, t) => {
        const v = flickerAt(t * 1.15);
        if (v > 0.5 && neu.L <= 0.5) { catches++; Sound.crackle(); if (catches === 1) buzz(6); }
        neu.L = v;
      }, ease.linear);
    }
    if (g !== gen) return;
    // 2. the light spreads: the room warms up, the fixture catches it
    page.classList.add('is-lit');
    say('Drita u ndez.');
    await wait(reduceMotion.matches ? 150 : 650);
    if (g !== gen) return;
    // 3. the light finds the logo
    Sound.play('mark', 0.85, reduceMotion.matches ? 0 : 0.5);
    await tween(reduceMotion.matches ? 0.4 : 2.0, (e, t) => {
      S.reveal = lerp(60, 420, e);
      S.logo = reduceMotion.matches ? t : clamp(t * 1.8, 0, 1);
    }, ease.inOut);
    if (g !== gen) return;
    await wait(reduceMotion.matches ? 0 : 150);
    if (g !== gen) return;
    // 4. the words
    setPhase('done');
    showPanel('done');
    ui.doneHead.focus({ preventScroll: true });
    say('Kur diçka prishet, Rregullo e gjen zgjidhjen. Gjej mjeshtrin e duhur për shtëpinë tënde.');
  }

  async function replay() {
    if (S.phase !== 'done') return;
    gen++;
    const g = gen;
    setPhase('reset');
    S.tweens.length = 0; S.carry = null; S.drag = null; S.quarter = false;
    Sound.humOff();
    page.classList.remove('is-lit');
    showPanel('play');
    hint('unscrew');
    // the light goes out, the logo goes back into the dark
    const L0 = neu.L, r0 = S.reveal, l0 = S.logo;
    await tween(reduceMotion.matches ? 0.2 : 0.7, (e) => {
      neu.L = L0 * (1 - e); S.logo = l0 * (1 - e); S.reveal = lerp(r0, 0, e); neu.opacity = 1 - e;
    }, ease.inOut);
    if (g !== gen) return;
    // and the burnt bulb is back where it was
    Object.assign(neu, { mode: 'free', x: REST.x, y: REST.y, rot: 0, p: TURNS, L: 0, opacity: 0 });
    Object.assign(old, { mode: 'socket', x: SEAT.x, y: SEAT.y, rot: 0, p: 0, L: 0, flick: 0, opacity: 0 });
    S.pRaw = 0; S.lastTick = 0; S.reveal = 0; S.logo = 0;
    await tween(reduceMotion.matches ? 0.15 : 0.45, (e) => { old.opacity = e; });
    if (g !== gen) return;
    setPhase('unscrew');
    activate(old, LABEL.old);
    ui.arc.classList.add('is-on');
    say(`Diçka nuk po shkon. A e rregullon? ${COPY.unscrew}`);
    if (keyboard) old.hit.focus({ preventScroll: true });
    scheduleFlicker();
  }

  /* -------- the burnt bulb: now and then a dying catch at the break */

  let flickerTimer = 0;
  function scheduleFlicker() {
    clearTimeout(flickerTimer);
    if (reduceMotion.matches) return;
    flickerTimer = setTimeout(async () => {
      if (S.phase !== 'unscrew' || document.hidden) { scheduleFlicker(); return; }
      const pattern = [[0, 0.5], [0.04, 0.05], [0.1, 0.32], [0.14, 0], [0.24, 0.18], [0.27, 0]];
      await tween(0.3, (e, t) => {
        let v = 0;
        for (const [at, val] of pattern) if (t * 0.3 >= at) v = val;
        old.flick = v;
      }, ease.linear);
      if (S.phase !== 'unscrew') return;
      old.flick = 0; draw();
      scheduleFlicker();
    }, 2200 + Math.random() * 3200);
  }

  /* -------- input */

  // Scene units per screen pixel, for turning: a swipe across the bulb turns it like a finger on the glass would.
  const unitsPerPx = () => { const m = scene.getScreenCTM(); return m ? 1 / m.a : 1; };
  const toScene = (e) => {
    const m = scene.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  };

  for (const b of [old, neu]) {
    // touches that start on a bulb belong to the game, so the page doesn't scroll under the finger
    b.hit.addEventListener('touchstart', (e) => { if (b.hit.classList.contains('is-active')) e.preventDefault(); }, { passive: false });
    b.hit.addEventListener('pointerdown', (e) => {
      if (!b.hit.classList.contains('is-active') || S.drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { b.hit.setPointerCapture(e.pointerId); } catch {}
      root.classList.add('is-dragging');
      const p = toScene(e);
      S.drag = { id: e.pointerId, b, x: e.clientX, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 };
      if (S.phase === 'fetch' && b === neu) {
        S.carry = { x: neu.x, y: neu.y, dx: p.x - neu.x, dy: p.y - neu.y };
        Sound.play('grip', 0.35);
      }
      run();
    });
    b.hit.addEventListener('pointermove', (e) => {
      const d = S.drag;
      if (!d || d.id !== e.pointerId) return;
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x0, e.clientY - d.y0));
      if (S.carry) {
        const p = toScene(e);
        S.carry.x = clamp(p.x - S.carry.dx, 100, 300);
        S.carry.y = clamp(p.y - S.carry.dy, 150, 400);
        run();
        return;
      }
      if (turning() !== b) return;
      const dx = e.clientX - d.x;
      d.x = e.clientX;
      if (d.moved < 4) return;
      // the finger travels over the glass, a cylinder of radius 34: angle = arc length / radius
      const deg = ((-dx * unitsPerPx()) / 34) * (180 / Math.PI) * 0.95;
      S.sway.v += dx * 0.05;
      turnBy(deg);
    });
    const end = (e) => {
      const d = S.drag;
      if (!d || d.id !== e.pointerId) return;
      S.drag = null;
      root.classList.remove('is-dragging');
      const tap = d.moved < 8 && performance.now() - d.t0 < 450 && e.type === 'pointerup';
      if (S.carry) {
        const near = nearSocket();
        S.carry = null;
        ui.target.classList.remove('is-near');
        if (tap || near) { place(); return; }
        // not there yet: it drifts back to where it was waiting
        const x0 = neu.x, y0 = neu.y, r0 = neu.rot;
        tween(0.45, (k) => { neu.x = lerp(x0, REST.x, k); neu.y = lerp(y0, REST.y, k); neu.rot = lerp(r0, 0, k); });
        return;
      }
      if (turning() !== b) return;
      if (tap) quarter(); else springBack();
    };
    b.hit.addEventListener('pointerup', end);
    b.hit.addEventListener('pointercancel', end);
    b.hit.addEventListener('lostpointercapture', end);

    b.hit.addEventListener('keydown', (e) => {
      if (!b.hit.classList.contains('is-active')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (S.phase === 'fetch' && b === neu) place();
        else if (turning() === b) quarter();
        return;
      }
      if (turning() !== b) return;
      const step = { ArrowLeft: 30, ArrowRight: -30 }[e.key];
      if (!step) return;
      e.preventDefault();
      turnBy(step);
      clearTimeout(b.keyTimer);
      b.keyTimer = setTimeout(springBack, 250);
    });
  }

  ui.replay.addEventListener('click', replay);

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

  // Where the bulb hangs on the page, so the room's light spreads from the right place
  const placeLight = () => {
    const m = scene.getScreenCTM();
    if (!m) return;
    const y = new DOMPoint(0, SEAT.y + GLASS_Y).matrixTransform(m).y - page.getBoundingClientRect().top;
    page.style.setProperty('--by', `${Math.round(y)}px`);
  };
  if ('ResizeObserver' in window) new ResizeObserver(placeLight).observe(ui.stage);
  addEventListener('resize', placeLight);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  addEventListener('pagehide', () => { clearTimeout(flickerTimer); Sound.humOff(); });

  // start
  setPhase('unscrew');
  activate(old, LABEL.old);
  ui.arc.classList.add('is-on');
  showPanel('play');
  S.hintKey = 'unscrew';
  placeLight();
  draw();
  scheduleFlicker();
}

mountGame();
