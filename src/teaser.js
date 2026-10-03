// Teaser drip: one drop swells at the spout, lets go, and rings on the surface below. Irregular, never busy.
// Runs only while the teaser is on screen; with reduced motion the drop just hangs there.
const art = document.querySelector('[data-teaser-art]');
if (art) {
  const hang = art.querySelector('[data-tz-hang]');
  const fall = art.querySelector('[data-tz-fall]');
  const rings = [...art.querySelectorAll('[data-tz-ring]')];
  const TIP = 75, FLOOR = 128, R = 5.2;
  const f = (n) => Math.round(n * 100) / 100;
  const shape = (r, c) => `M-2 0C-2 ${f(c * .3)} ${f(-r)} ${f(c - r * .5)} ${f(-r)} ${f(c)}A${f(r)} ${f(r)} 0 1 0 ${f(r)} ${f(c)}C${f(r)} ${f(c - r * .5)} 2 ${f(c * .3)} 2 0Z`;
  const drawHang = (v) => { const r = R * Math.cbrt(v); hang.setAttribute('d', r < .5 ? '' : shape(r, r * 1.1)); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  let vol = .3, interval = 2.2, drop = null, ring = [], raf = 0, last = 0, visible = false;
  const frame = (now) => {
    raf = 0;
    const dt = Math.min(.05, (now - last) / 1000 || 0); last = now;
    vol += dt / interval;
    if (vol >= 1) { drop = { y: TIP + R * 1.5, v: 0 }; vol = .05; interval = 1.6 + Math.random() * 1.6; }
    drawHang(vol);
    if (drop) {
      drop.v += 1500 * dt; drop.y += drop.v * dt;
      if (drop.y >= FLOOR - 1) { drop = null; ring = [0, -.12]; fall.setAttribute('opacity', 0); }
      else { fall.setAttribute('opacity', 1); fall.setAttribute('transform', `translate(70 ${f(drop.y)})`); }
    }
    ring = ring.map((t) => t + dt);
    rings.forEach((el, i) => {
      const t = ring[i];
      if (t === undefined || t < 0 || t > 1) { el.setAttribute('opacity', 0); return; }
      const rr = 2 + 26 * (1 - Math.pow(1 - t, 3));
      el.setAttribute('rx', f(rr)); el.setAttribute('ry', f(rr * .3)); el.setAttribute('opacity', f((i ? .3 : .55) * Math.pow(1 - t, 1.6)));
    });
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && visible && !reduce.matches) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  drawHang(reduce.matches ? .85 : vol);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) start(); }).observe(art);
  }
  document.addEventListener('visibilitychange', start);
  reduce.addEventListener?.('change', () => { if (reduce.matches) drawHang(.85); else start(); });
}

// Level teaser: the bubble in the O drifts off, then the level comes true and it settles between the lines
// (the ident easing). It rests there a while before the next nudge. Reduced motion: it simply sits centred.
const levelArt = document.querySelector('[data-zhive-art]');
if (levelArt) {
  const bubble = levelArt.querySelector('[data-zt-bubble]');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const f = (n) => Math.round(n * 100) / 100;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const swing = (t) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  // one cycle: rest centred, glide out to one side, settle back
  let side = -1, from = 0, to = 0, t0 = 0, dur = 1, rest = true, raf = 0, visible = false;
  const set = (x) => bubble.setAttribute('transform', `translate(${f(x)} 0)`);
  const next = (now) => {
    t0 = now; from = to; rest = !rest;
    if (rest) { dur = to === 0 ? 1.8 + Math.random() * 1.4 : .45; return; }
    if (from === 0) { side = -side; to = side * (10 + Math.random() * 5); dur = 1.3; }
    else { to = 0; dur = 1.2; }
  };
  const frame = (now) => {
    raf = 0;
    const t = Math.min(1, (now - t0) / 1000 / dur);
    if (!rest) set(from + (to - from) * (to === 0 ? ease(t) : swing(t)));
    if (t >= 1) next(now);
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf && visible && !reduce.matches) { t0 = performance.now(); raf = requestAnimationFrame(frame); } };
  set(0);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) start(); }).observe(levelArt);
  }
  document.addEventListener('visibilitychange', start);
  reduce.addEventListener?.('change', () => { if (reduce.matches) { to = 0; set(0); } else start(); });
}
