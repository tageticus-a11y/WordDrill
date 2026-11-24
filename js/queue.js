// The queue (pure): raw notes waiting to become cards, one folder per area, queue/<key>/0001.md, 0002.md …
// The front of the queue is the lowest number. Files hold no heading (all cards in section ''), so
// renaming an area never touches them. Appending makes a new file only at the end, when the last one is
// full; "soon" inserts go into an existing file (which may then hold a few more than fileSize), so cards
// never cascade from file to file. A queue file left without cards is deleted by the sync engine.

export const QUEUE_SECTION = '';
export const DEFAULT_QUEUE = { fileSize: 50, soonAfter: 50 };
const clampN = (v, d) => (Number.isInteger(v) ? Math.max(5, Math.min(500, v)) : d);

/** state.json "queue": { fileSize, soonAfter } with defaults */
export function queueSettings(state) {
  const q = (state && typeof state.queue === 'object' && state.queue) || {};
  return { fileSize: clampN(q.fileSize, DEFAULT_QUEUE.fileSize), soonAfter: clampN(q.soonAfter, DEFAULT_QUEUE.soonAfter) };
}

const QUEUE_RE = /^queue\/([^/]+)\/(\d{4,})\.md$/;
export const queueDir = key => 'queue/' + key + '/';
export const queuePath = (key, n) => queueDir(key) + String(n).padStart(4, '0') + '.md';
export const isQueueFile = path => QUEUE_RE.test(path);
export const queueNumber = path => { const m = String(path).match(QUEUE_RE); return m ? +m[2] : 0; };
/** The queue files of an area among paths, front first */
export const queueFiles = (paths, key) =>
  paths.filter(p => isQueueFile(p) && p.startsWith(queueDir(key))).sort((a, b) => queueNumber(a) - queueNumber(b));
export const nextQueuePath = (paths, key) => queuePath(key, Math.max(0, ...queueFiles(paths, key).map(queueNumber)) + 1);

/**
 * Where a card added at the end goes. files: [{ path, count }] front first.
 * → { path, index }: the last file while it holds fewer than fileSize cards, otherwise a new file.
 */
export function appendTarget(files, key, { fileSize } = DEFAULT_QUEUE) {
  const last = files[files.length - 1];
  if (last && last.count < fileSize) return { path: last.path, index: last.count };
  return { path: queuePath(key, last ? queueNumber(last.path) + 1 : 1), index: 0 };
}

/** Where a card added "soon" goes: after the first soonAfter cards, counted across files; a shorter queue: the end */
export function soonTarget(files, key, settings = DEFAULT_QUEUE) {
  let left = settings.soonAfter;
  for (const f of files) {
    if (left <= f.count) return { path: f.path, index: left };
    left -= f.count;
  }
  return appendTarget(files, key, settings);
}
/** How many front files soonTarget may need to look at (load them first) */
export function filesForSoon(counts, soonAfter) {
  let n = 0, seen = 0;
  for (const c of counts) { n++; seen += c; if (seen >= soonAfter) break; }
  return n;
}

/** Text pasted or exported from notes → blocks (cards) separated by empty or whitespace-only lines */
export function splitBlocks(text) {
  const blocks = [];
  let cur = [];
  for (const line of String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim()) cur.push(line);
    else if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
