// Rregullo coming-soon page. Everything here is progressive: without it the page is complete,
// the hero shows the crisp SVG logo and every section is visible.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Hero film: the 2.4 web cut, muted. It plays once when the stage is on screen and hands off to the
// SVG logo that sits exactly where the film's last frame draws it. The brand rule is that the film
// plays once and never loops; "Shiko sërish" replays it.
function mountFilm(stage) {
  const video = stage.querySelector('video');
  const replay = stage.querySelector('.stage-replay');
  if (!video || reduceMotion.matches || !('IntersectionObserver' in window)) return;

  // Respect data savers: keep the still logo and offer the film on request.
  const saveData = navigator.connection && navigator.connection.saveData;
  let started = false;

  const showReplay = () => { replay.hidden = false; };
  const settle = () => { stage.classList.remove('is-playing'); stage.classList.add('is-done'); };
  const fail = () => { stage.classList.remove('is-playing', 'is-done'); showReplay(); };

  const play = () => {
    started = true;
    replay.hidden = true;
    stage.classList.remove('is-done');
    video.preload = 'auto';
    if (video.readyState > 0) video.currentTime = 0;
    const p = video.play();
    // Autoplay can be refused (low-power mode, data saver): the logo stays and the visitor can start it.
    if (p && p.catch) p.catch((e) => { if (e && e.name === 'AbortError') return; stage.classList.remove('is-playing'); showReplay(); });
  };

  video.addEventListener('playing', () => { replay.hidden = true; stage.classList.remove('is-done'); stage.classList.add('is-playing'); });
  video.addEventListener('ended', () => { settle(); showReplay(); });
  // Each <source> the browser can't use fires its own error and the next one is tried; only the last means no film.
  const sources = video.querySelectorAll('source');
  if (sources.length) sources[sources.length - 1].addEventListener('error', fail);
  video.addEventListener('error', fail);
  replay.addEventListener('click', play);

  // Pause off screen, resume when back; start the first time the stage is mostly visible.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.intersectionRatio >= 0.5) {
        if (!started && !saveData) play();
        else if (started && video.paused && !video.ended && stage.classList.contains('is-playing')) video.play().catch(() => {});
      } else if (!video.paused) {
        video.pause();
      }
    }
  }, { threshold: [0, 0.5] });
  io.observe(stage);
  if (saveData) showReplay();

  document.addEventListener('visibilitychange', () => { if (document.hidden && !video.paused) video.pause(); });

  // If the visitor turns on reduced motion mid-visit, stop and show the logo.
  reduceMotion.addEventListener?.('change', (m) => { if (m.matches) { video.pause(); settle(); replay.hidden = true; io.disconnect(); } });
}

// Sections that start below the fold fade in once. Anything already on screen is left alone.
function mountReveals() {
  if (reduceMotion.matches || !('IntersectionObserver' in window)) return;
  const items = [...document.querySelectorAll('.reveal')].filter((el) => el.getBoundingClientRect().top > innerHeight);
  if (!items.length) return;
  items.forEach((el) => el.classList.add('is-pending'));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.remove('is-pending'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  items.forEach((el) => io.observe(el));
}

const stage = document.querySelector('[data-film]');
if (stage) mountFilm(stage);
mountReveals();
