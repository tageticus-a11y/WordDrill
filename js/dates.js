// Dates are local calendar days as 'YYYY-MM-DD' strings: they compare correctly as strings.

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

export const WEEKDAYS = [
  { n: 1, key: 'mon', name: 'Monday' }, { n: 2, key: 'tue', name: 'Tuesday' },
  { n: 3, key: 'wed', name: 'Wednesday' }, { n: 4, key: 'thu', name: 'Thursday' },
  { n: 5, key: 'fri', name: 'Friday' }, { n: 6, key: 'sat', name: 'Saturday' },
  { n: 7, key: 'sun', name: 'Sunday' }
].map(d => ({ ...d, file: 'week/' + d.n + '-' + d.key + '.md' }));
export const WEEK_FILES = WEEKDAYS.map(d => d.file);

/** 1 = Monday … 7 = Sunday */
export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(y, m - 1, d).getDay() + 6) % 7) + 1;
}
export const weekday = date => WEEKDAYS[weekdayOf(date) - 1];
export const weekFile = date => weekday(date).file;

/** A card in a weekday file is due for the check unless it was moved there today (or later) */
export const isDue = (card, date) => !(card.meta && card.meta.moved && card.meta.moved >= date);

export const monthOf = date => date.slice(0, 7);
export const archiveFile = (sectionKey, date) => 'archive/' + sectionKey + '/' + monthOf(date) + '.md';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = ym => MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);
