// Recall timer (pure): cycles of CYCLE_MS (10 s), like the CountDown page. The state keeps wall-clock
// times, so the timer keeps counting through reloads, tab switches and the app being in the background.
// state: { total, startAt: ms | null (null = not running), elapsed: ms counted before startAt }

export const CYCLE_MS = 10000;
export const DEFAULT_TOTAL = 21;
const SECONDS = CYCLE_MS / 1000;

export const clampTotal = n => Math.max(1, Math.min(999, Math.round(Number(n)) || DEFAULT_TOTAL));

/** A saved state, or a fresh one of `cycles` (anything broken is replaced) */
export function timerState(saved, cycles = DEFAULT_TOTAL) {
  if (!saved || typeof saved !== 'object') return { total: clampTotal(cycles), startAt: null, elapsed: 0 };
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

/* ---- Settings (state.json "timer": { cycles, shortcut }) ---- */

export const DEFAULT_SHORTCUT = 'Alt+KeyB';

/** Timer settings from state.json; shortcut '' means none */
export function timerSettings(state) {
  const t = (state && typeof state.timer === 'object' && state.timer) || {};
  return {
    cycles: t.cycles == null ? DEFAULT_TOTAL : clampTotal(t.cycles),
    shortcut: typeof t.shortcut === 'string' ? t.shortcut : DEFAULT_SHORTCUT
  };
}

const MODIFIER_CODE = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
/**
 * A key press as a shortcut: "Ctrl+Alt+Shift+Meta+<code>" (only the modifiers held; KeyboardEvent.code,
 * so it doesn't depend on the keyboard layout, e.g. Armenian or Russian).
 * null: only a modifier is pressed so far. '' : not allowed (needs Ctrl, Alt or Win/Cmd, unless it is an F key).
 */
export function shortcutOf(ev) {
  if (!ev.code || MODIFIER_CODE.test(ev.code)) return null;
  const mods = [ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift', ev.metaKey && 'Meta'].filter(Boolean);
  if (!/^F\d{1,2}$/.test(ev.code) && !mods.some(m => m !== 'Shift')) return '';
  return [...mods, ev.code].join('+');
}
export const matchesShortcut = (ev, shortcut) => !!shortcut && shortcutOf(ev) === shortcut;

/** "Alt+KeyT" → "Alt+T", "Ctrl+Shift+Digit1" → "Ctrl+Shift+1" */
export function shortcutLabel(shortcut) {
  if (!shortcut) return 'None';
  return shortcut.split('+').map(p => p === 'Meta' ? 'Win/Cmd' : p.replace(/^Key([A-Z])$/, '$1').replace(/^Digit(\d)$/, '$1').replace(/^Numpad/, 'Num ')).join('+');
}

/** Milestones of a run: at 2/5 and 4/5 of the whole time (the line under the header shows them) */
export const MILESTONES = [0.4, 0.8];
/** Milestones passed between two moments (elapsed ms): [{ k (1-based), at }] */
export function milestonesPassed(s, from, to) {
  return MILESTONES.map((f, i) => ({ k: i + 1, at: Math.round(f * s.total * CYCLE_MS) }))
    .filter(m => m.at > from && m.at <= to && m.at < s.total * CYCLE_MS);
}
