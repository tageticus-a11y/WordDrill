// The recall timer on the page (browser only): a small ring in the header that opens a panel with the big
// ring, the cycle count and Start/Pause/Reset, like the CountDown page. Alt+T starts or pauses it.
// Sounds are made with Web Audio (a ding at the end of each cycle, two pitches in turn, three beeps at the end),
// plus vibration where the device can (Vibrate, on by default; not on iPhone, see vibrate()).

import { timerState, timerView, startTimer, pauseTimer, resetTimer, setTotal, cycleEnds, elapsedOf } from './timer.js';

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--alert)', 'var(--ok)'];    // cycles in turn: red, green
const colorOf = cycle => COLORS[(cycle - 1) % COLORS.length];

function el(tag, attrs = {}, ...kids) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
// A ring: track + progress arc, started at 12 o'clock
function ring(size, width) {
  const r = (size - width) / 2, len = 2 * Math.PI * r;
  const arc = el('svg:circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': width, 'stroke-linecap': 'round',
    'stroke-dasharray': len, 'stroke-dashoffset': len, transform: `rotate(-90 ${size / 2} ${size / 2})` });
  const svg = el('svg:svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
    el('svg:circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': width, class: 'track' }), arc);
  return { svg, set(progress, color) { arc.setAttribute('stroke-dashoffset', len * (1 - progress)); arc.style.stroke = color; arc.style.opacity = progress > 0 ? 1 : 0; } };
}

// ---- Sounds ----
let audio = null;
function audioCtx() {   // created and resumed inside a tap or key press (browsers allow sound only after one)
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!audio) audio = new C();
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}
function tone(c, freq, at, dur, type = 'sine', vol = 0.25) {
  const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
const SOUNDS = {
  odd: c => { tone(c, 880, 0, 1.3); tone(c, 1760, 0, 0.5, 'sine', 0.06); },
  even: c => { tone(c, 660, 0, 1.3); tone(c, 1320, 0, 0.5, 'sine', 0.06); },
  final: c => { tone(c, 988, 0, 0.22, 'triangle', 0.3); tone(c, 988, 0.32, 0.22, 'triangle', 0.3); tone(c, 1319, 0.64, 1, 'triangle', 0.3); }
};
function play(name) { const c = audioCtx(); if (c) try { SOUNDS[name](c); } catch (e) {} }

// ---- Vibration ----
// The Vibration API where there is one (Android Chrome). iPhones have none: the old haptic trick (a script
// click on an <input switch>) was closed in iOS 26.5, so Vibrate isn't offered there. Pulses: 1 / 2 / 3.
const CAN_VIBRATE = typeof navigator.vibrate === 'function';
const PULSES = { odd: 1, even: 2, final: 3 };
function vibrate(name) {
  if (!CAN_VIBRATE) return;
  const n = PULSES[name] || 1;
  navigator.vibrate(name === 'final' ? [250, 120, 250, 120, 500] : Array.from({ length: n * 2 - 1 }, (_, i) => (i % 2 ? 90 : 120)));
}

export function mountTimer({ button, panel, store }) {
  let s = timerState(store.get('wd.timer'));
  let open = store.get('wd.timerOpen') === true;
  let last = elapsedOf(s, Date.now());
  let loop = null;
  const save = () => store.set('wd.timer', s);
  let buzz = store.get('wd.timerVibrate') !== false;   // on unless turned off (this device only)
  const signal = name => { play(name); if (buzz) vibrate(name); };

  // Header button: a small ring with the cycles left (a stopwatch when the timer is idle)
  const mini = ring(28, 3.5);
  const miniText = el('span', { class: 'timer-mini-text' });
  button.append(mini.svg, miniText);

  // Panel
  const big = ring(96, 8);
  const secs = el('span', { class: 'timer-secs' });
  const cycleText = el('div', { class: 'timer-cycle' });
  const total = el('input', { type: 'number', min: '1', max: '999', inputmode: 'numeric', 'aria-label': 'Number of cycles' });
  total.addEventListener('change', () => { s = setTotal(s, total.value, Date.now()); last = elapsedOf(s, Date.now()); save(); draw(); });
  const vib = el('input', { type: 'checkbox' });
  vib.checked = buzz;
  vib.addEventListener('change', () => { buzz = vib.checked; store.set('wd.timerVibrate', buzz); if (buzz) vibrate('odd'); });
  const startBtn = el('button', { type: 'button', class: 'primary', onclick: () => toggle() });
  const resetBtn = el('button', { type: 'button', text: 'Reset', onclick: () => { s = resetTimer(s); last = 0; save(); stopLoop(); draw(); } });
  panel.append(
    el('div', { class: 'timer-ring' }, big.svg, secs),
    el('div', { class: 'timer-side' },
      cycleText,
      el('label', { class: 'timer-total' }, el('span', { text: 'Cycles of 10 s' }), total),
      CAN_VIBRATE ? el('label', { class: 'timer-vibrate' }, vib, el('span', { text: 'Vibrate' })) : '',
      el('div', { class: 'timer-buttons' }, startBtn, resetBtn)),
    el('button', { type: 'button', class: 'icon timer-close', title: 'Close', 'aria-label': 'Close timer', text: '✕', onclick: () => setOpen(false) }));

  function setOpen(v) { open = v; store.set('wd.timerOpen', v); draw(); }
  function startLoop() { if (!loop) loop = setInterval(tick, 200); }
  function stopLoop() { clearInterval(loop); loop = null; }
  function toggle() {
    const now = Date.now();
    if (timerView(s, now).running) { s = pauseTimer(s, now); stopLoop(); }
    else { audioCtx(); s = startTimer(s, now); signal('even'); startLoop(); }
    last = elapsedOf(s, now);
    save(); draw();
  }
  function tick() {
    const now = Date.now(), e = elapsedOf(s, now);
    if (s.startAt != null) {
      const ends = cycleEnds(s, last, e), end = ends[ends.length - 1];
      if (end && e - end.at < 2000) signal(end.sound);   // not a pile of old dings after the app was in the background
      if (timerView(s, now).done) { s = resetTimer(s); save(); stopLoop(); last = 0; draw(); return; }
    }
    last = e;
    draw();
  }
  function draw() {
    const v = timerView(s, Date.now());
    const idle = !v.running && s.elapsed === 0;
    const color = colorOf(v.cycle);
    mini.set(idle ? 0 : v.progress, color);
    miniText.textContent = idle ? '⏱' : String(v.cyclesLeft);
    button.classList.toggle('running', v.running);
    button.classList.toggle('on', open);
    button.title = v.running ? 'Timer: cycle ' + v.cycle + ' of ' + v.total + ' (Alt+T pauses)' : 'Timer (Alt+T starts)';
    panel.hidden = !open;
    if (!open) return;
    big.set(v.progress, color);
    secs.textContent = String(v.timeLeft || 10);
    secs.style.color = idle ? '' : color;
    cycleText.textContent = 'Cycle ' + v.cycle + ' / ' + v.total;
    if (document.activeElement !== total) total.value = String(s.total);
    startBtn.textContent = v.running ? 'Pause' : s.elapsed > 0 ? 'Resume' : 'Start';
  }

  button.addEventListener('click', () => setOpen(!open));
  document.addEventListener('keydown', ev => {
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.code === 'KeyT') { ev.preventDefault(); toggle(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  if (timerView(s, Date.now()).running) startLoop(); else if (s.startAt != null) tick();   // finished while closed
  draw();
}
