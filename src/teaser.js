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
