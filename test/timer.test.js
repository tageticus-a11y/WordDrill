import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE_MS, timerState, timerView, startTimer, pauseTimer, resetTimer, setTotal, cycleEnds, timerSettings, shortcutOf, matchesShortcut, shortcutLabel } from '../js/timer.js';

test('fresh and broken saved states', () => {
  assert.deepEqual(timerState(null), { total: 21, startAt: null, elapsed: 0 });
  assert.deepEqual(timerState({ total: 'x', startAt: 'y', elapsed: -5 }), { total: 21, startAt: null, elapsed: 0 });
  assert.deepEqual(timerState({ total: 3, startAt: 1000, elapsed: 0 }), { total: 3, startAt: 1000, elapsed: 0 });
});

test('counts 10…1 in each cycle, then the next cycle', () => {
  let s = startTimer(timerState({ total: 3 }), 0);
  assert.deepEqual(timerView(s, 0), { running: true, done: false, cycle: 1, total: 3, timeLeft: 10, progress: 0, cyclesLeft: 3 });
  assert.equal(timerView(s, 999).timeLeft, 10);
  assert.equal(timerView(s, 1000).timeLeft, 9);
  assert.equal(timerView(s, 9999).timeLeft, 1);
  const v = timerView(s, CYCLE_MS + 2500);
  assert.equal(v.cycle, 2); assert.equal(v.timeLeft, 8); assert.equal(v.progress, 0.25); assert.equal(v.cyclesLeft, 2);
  const end = timerView(s, 3 * CYCLE_MS + 5);
  assert.equal(end.done, true); assert.equal(end.running, false); assert.equal(end.cycle, 3);
});

test('pause keeps the time; start resumes; a finished timer starts over', () => {
  let s = startTimer(timerState({ total: 2 }), 1000);
  s = pauseTimer(s, 6500);
  assert.equal(s.startAt, null); assert.equal(s.elapsed, 5500);
  assert.equal(timerView(s, 99999).timeLeft, 5);           // stopped: time doesn't move
  s = startTimer(s, 20000);
  assert.equal(timerView(s, 20000).timeLeft, 5);
  assert.equal(startTimer(s, 21000), s);                  // already running
  const fin = startTimer(s, 1e9);                          // long finished
  assert.equal(timerView(fin, 1e9).cycle, 1);
  assert.equal(timerView(fin, 1e9).timeLeft, 10);
  assert.deepEqual(resetTimer(s, 5), { total: 5, startAt: null, elapsed: 0 });
});

test('changing the number of cycles', () => {
  const stopped = pauseTimer(startTimer(timerState({ total: 5 }), 0), 15000);
  assert.deepEqual(setTotal(stopped, 8, 20000), { total: 8, startAt: null, elapsed: 0 });
  const running = startTimer(timerState({ total: 5 }), 0);
  assert.equal(setTotal(running, 9, 25000).startAt, 0);
  assert.equal(setTotal(running, 1, 25000).total, 3);      // not below the current cycle
});

test('cycle ends for the sounds: odd, even, final', () => {
  const s = timerState({ total: 3 });
  assert.deepEqual(cycleEnds(s, 9000, 10500).map(e => e.sound), ['odd']);
  assert.deepEqual(cycleEnds(s, 10500, 19000), []);
  assert.deepEqual(cycleEnds(s, 0, 99999).map(e => [e.n, e.sound]), [[1, 'odd'], [2, 'even'], [3, 'final']]);
  assert.deepEqual(cycleEnds(timerState({ total: 1 }), 0, 10000).map(e => e.sound), ['final']);
});

test('timer settings from state.json', () => {
  assert.deepEqual(timerSettings({}), { cycles: 21, shortcut: 'Alt+KeyT' });
  assert.deepEqual(timerSettings({ timer: { cycles: 12, shortcut: '' } }), { cycles: 12, shortcut: '' });
  assert.deepEqual(timerSettings({ timer: { cycles: 'x', shortcut: 5 } }), { cycles: 21, shortcut: 'Alt+KeyT' });
  assert.deepEqual(timerSettings({ timer: null }), { cycles: 21, shortcut: 'Alt+KeyT' });
  assert.equal(timerState(null, 12).total, 12);
});

test('shortcuts from key presses', () => {
  const key = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(shortcutOf(key('KeyT', { altKey: true })), 'Alt+KeyT');
  assert.equal(shortcutOf(key('Digit1', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Digit1');
  assert.equal(shortcutOf(key('F2')), 'F2');
  assert.equal(shortcutOf(key('ShiftLeft', { shiftKey: true })), null);      // still choosing
  assert.equal(shortcutOf(key('AltRight', { altKey: true })), null);
  assert.equal(shortcutOf(key('KeyT')), '');                                // would fire while typing
  assert.equal(shortcutOf(key('KeyT', { shiftKey: true })), '');
  assert.ok(matchesShortcut(key('KeyT', { altKey: true }), 'Alt+KeyT'));
  assert.ok(!matchesShortcut(key('KeyT', { altKey: true, shiftKey: true }), 'Alt+KeyT'));
  assert.ok(!matchesShortcut(key('KeyT', { altKey: true }), ''));
  assert.equal(shortcutLabel('Alt+KeyT'), 'Alt+T');
  assert.equal(shortcutLabel('Ctrl+Shift+Digit1'), 'Ctrl+Shift+1');
  assert.equal(shortcutLabel('Meta+Space'), 'Win/Cmd+Space');
  assert.equal(shortcutLabel(''), 'None');
});
