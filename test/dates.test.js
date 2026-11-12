import { test } from 'node:test';
import assert from 'node:assert/strict';
import { today, weekdayOf, weekFile, isDue, archiveFile, monthLabel, WEEK_FILES } from '../js/dates.js';

test('today formats a local date', () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(today(new Date(2026, 10, 12, 0, 0)), '2026-11-12');
});

test('weekday files', () => {
  assert.equal(weekdayOf('2026-11-12'), 4);   // Thursday
  assert.equal(weekdayOf('2026-11-16'), 1);   // Monday
  assert.equal(weekdayOf('2026-11-15'), 7);   // Sunday
  assert.equal(weekFile('2026-11-12'), 'week/4-thu.md');
  assert.equal(weekFile('2026-11-15'), 'week/7-sun.md');
  assert.equal(WEEK_FILES.length, 7);
  assert.equal(new Set(WEEK_FILES).size, 7);
});

test('due for check: moved before today, or never dated', () => {
  assert.equal(isDue({ meta: { moved: '2026-11-05' } }, '2026-11-12'), true);
  assert.equal(isDue({ meta: { moved: '2026-11-12' } }, '2026-11-12'), false);
  assert.equal(isDue({ meta: {} }, '2026-11-12'), true);
});

test('archive paths by month, across year end', () => {
  assert.equal(archiveFile('armenian', '2026-11-12'), 'archive/armenian/2026-11.md');
  assert.equal(archiveFile('english', '2026-12-31'), 'archive/english/2026-12.md');
  assert.equal(archiveFile('english', '2027-01-01'), 'archive/english/2027-01.md');
  assert.equal(monthLabel('2027-01'), 'January 2027');
});
