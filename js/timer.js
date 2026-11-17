// Recall timer (pure): cycles of CYCLE_MS (10 s), like the CountDown page. The state keeps wall-clock
// times, so the timer keeps counting through reloads, tab switches and the app being in the background.
// state: { total, startAt: ms | null (null = not running), elapsed: ms counted before startAt }

export const CYCLE_MS = 10000;
export const DEFAULT_TOTAL = 21;
const SECONDS = CYCLE_MS / 1000;

const clampTotal = n => Math.max(1, Math.min(999, Math.round(Number(n)) || DEFAULT_TOTAL));

/** A saved state, or a fresh one (anything broken is replaced) */
export function timerState(saved) {
  if (!saved || typeof saved !== 'object') return { total: DEFAULT_TOTAL, startAt: null, elapsed: 0 };
  return {
    total: clampTotal(saved.total),
    startAt: Number.isFinite(saved.startAt) ? saved.startAt : null,
    elapsed: Number.isFinite(saved.elapsed) && saved.elapsed > 0 ? saved.elapsed : 0
  };
}

export const elapsedOf = (s, now) => (s.startAt != null ? Math.max(0, now - s.startAt) : s.elapsed);
const endOf = s => s.total * CYCLE_MS;

/** What to show: cycle (1-based), seconds left in the cycle (10…1), progress of the cycle (0…1) */
export function timerView(s, now) {
  const e = Math.min(elapsedOf(s, now), endOf(s));
  const done = e >= endOf(s);
  const cycle = done ? s.total : Math.floor(e / CYCLE_MS) + 1;
  const inCycle = done ? CYCLE_MS : e - (cycle - 1) * CYCLE_MS;
  return {
    running: s.startAt != null && !done, done, cycle, total: s.total,
    timeLeft: done ? 0 : SECONDS - Math.floor(inCycle / 1000),
    progress: inCycle / CYCLE_MS,
    cyclesLeft: s.total - cycle + 1
  };
}

export const startTimer = (s, now) => {
  if (s.startAt != null && elapsedOf(s, now) < endOf(s)) return s;   // already running
  const base = elapsedOf(s, now) >= endOf(s) ? 0 : s.elapsed;           // finished: start over
  return { ...s, startAt: now - base, elapsed: base };
};
export const pauseTimer = (s, now) => (s.startAt == null ? s : { ...s, startAt: null, elapsed: Math.min(elapsedOf(s, now), endOf(s)) });
export const resetTimer = (s, total = s.total) => ({ total: clampTotal(total), startAt: null, elapsed: 0 });
/** New number of cycles: a stopped timer starts over, a running one keeps going */
export const setTotal = (s, total, now) => (s.startAt == null ? resetTimer(s, total) : { ...s, total: Math.max(clampTotal(total), timerView(s, now).cycle) });

/**
 * Cycle ends passed between two moments (elapsed ms), for the sounds:
 * [{ n, sound: 'odd' | 'even' | 'final', at }] where at is the elapsed ms of that end.
 */
export function cycleEnds(s, from, to) {
  const out = [];
  for (let n = Math.floor(from / CYCLE_MS) + 1; n * CYCLE_MS <= Math.min(to, endOf(s)); n++) {
    out.push({ n, at: n * CYCLE_MS, sound: n === s.total ? 'final' : n % 2 ? 'odd' : 'even' });
  }
  return out;
}
