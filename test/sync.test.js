import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../js/sync.js';
import { parseDoc, allCards, parseState } from '../js/format.js';
import { addOp, editOp, deleteOp, rememberOp, archiveOp, stateOp, CURRENT, renameSectionPlan } from '../js/ops.js';
import { WEEK_FILES } from '../js/dates.js';

const CORE = [CURRENT, 'state.json', ...WEEK_FILES];
const DAY = '2026-11-12', WEEK = 'week/4-thu.md';

// In-memory Dropbox with revs and failure injection
function fakeDropbox() {
  const files = new Map();
  let revN = 0;
  const fail = [];   // queued failures: { on: 'upload'|'download'|'list', kind: 'network'|'after-write', path? }
  const conflict = () => Object.assign(new Error('Dropbox: path/conflict/file/'), { conflict: true });
  const take = (on, path) => {
    const i = fail.findIndex(f => f.on === on && (!f.path || f.path === path));
    return i < 0 ? null : fail.splice(i, 1)[0];
  };
  const api = {
    calls: 0,
    async list() { api.calls++; if (take('list')) throw new TypeError('Failed to fetch'); return [...files].map(([path, f]) => ({ path, rev: f.rev })); },
    async download(path) {
      api.calls++;
      if (take('download', path)) throw new TypeError('Failed to fetch');
      const f = files.get(path); return f ? { text: f.text, rev: f.rev } : null;
    },
    async upload(path, text, rev) {
      api.calls++;
      const f = take('upload', path);
      if (f && f.kind === 'network') throw new TypeError('Failed to fetch');
      const cur = files.get(path);
      if (rev == null ? cur : !cur || cur.rev !== rev) throw conflict();
      files.set(path, { text, rev: 'r' + ++revN });
      if (f && f.kind === 'after-write') throw new TypeError('Failed to fetch');   // saved, but the reply was lost
      return { rev: 'r' + revN };
    }
  };
  return { api, files, fail, put: (p, text) => files.set(p, { text, rev: 'r' + ++revN }), text: p => files.get(p)?.text };
}
const memStorage = () => { const m = new Map(); return { get: k => (m.has(k) ? JSON.parse(m.get(k)) : null), set: (k, v) => m.set(k, JSON.stringify(v)), m }; };
const cards = text => allCards(parseDoc(text || ''));
const ids = text => cards(text).map(c => c.id);
const totalCards = db => [...db.files].filter(([p]) => p.endsWith('.md')).reduce((n, [, f]) => n + cards(f.text).length, 0);

test('first run on an empty Dropbox: add, sync, files appear', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  const op = eng.add(addOp(CURRENT, 'Armenian', '**ամուր**', DAY));
  assert.equal(allCards(eng.doc(CURRENT))[0].body, '**ամուր**');   // visible before upload
  await eng.flush();
  assert.equal(eng.pending(), 0);
  assert.deepEqual(ids(db.text(CURRENT)), [op.card.id]);
});

test('offline edits stay queued (and persisted) until the network returns', async () => {
  const db = fakeDropbox(), storage = memStorage();
  let eng = createEngine({ api: db.api, storage });
  await eng.sync(CORE);
  eng.add(addOp(CURRENT, 'English', 'word', DAY));
  db.fail.push({ on: 'upload', kind: 'network' });
  await assert.rejects(eng.flush(), TypeError);
  assert.equal(eng.pending(), 1);
  // App restarted: the queue comes back from storage
  eng = createEngine({ api: db.api, storage });
  assert.equal(allCards(eng.doc(CURRENT))[0].body, 'word');
  await eng.sync(CORE);
  assert.equal(eng.pending(), 0);
  assert.equal(cards(db.text(CURRENT))[0].body, 'word');
});

test('two devices editing the same file: both changes kept', async () => {
  const db = fakeDropbox();
  const a = createEngine({ api: db.api, storage: memStorage() }), b = createEngine({ api: db.api, storage: memStorage() });
  await a.sync(CORE); await b.sync(CORE);
  a.add(addOp(CURRENT, 'Armenian', 'from A', DAY));
  b.add(addOp(CURRENT, 'English', 'from B', DAY));
  await a.flush();
  await b.flush();   // conflict → re-download → replay
  const bodies = cards(db.text(CURRENT)).map(c => c.body).sort();
  assert.deepEqual(bodies, ['from A', 'from B']);
  await a.sync(CORE);
  assert.equal(allCards(a.doc(CURRENT)).length, 2);
});

test('remember: card leaves current only after it is saved in the weekday file', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  eng.add(addOp(CURRENT, 'Armenian', 'w1', DAY));
  await eng.flush();
  const card = allCards(eng.doc(CURRENT))[0];
  eng.add(rememberOp('Armenian', card, DAY));
  // The upload of the source fails after the target was written
  db.fail.push({ on: 'upload', path: CURRENT, kind: 'network' });
  await assert.rejects(eng.flush());
  assert.equal(totalCards(db), 2);                       // duplicated for a moment, never lost
  assert.deepEqual(ids(db.text(WEEK)), [card.id]);
  // The UI already shows the finished move
  assert.equal(allCards(eng.doc(CURRENT)).length, 0);
  await eng.flush();
  assert.equal(totalCards(db), 1);
  assert.deepEqual(ids(db.text(CURRENT)), []);
  assert.equal(cards(db.text(WEEK))[0].meta.moved, DAY);
});

test('a lost reply after a successful write is not applied twice', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  eng.add(addOp(CURRENT, 'General', 'once', DAY));
  db.fail.push({ on: 'upload', path: CURRENT, kind: 'after-write' });
  await assert.rejects(eng.flush());
  await eng.flush();
  assert.equal(cards(db.text(CURRENT)).length, 1);
  assert.equal(eng.pending(), 0);
});

test('full cycle keeps every card: current → week → archive, forgot deletes exactly one', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  for (const [s, b] of [['Armenian', 'a1'], ['Armenian', 'a2'], ['English', 'e1'], ['General', 'g1']]) eng.add(addOp(CURRENT, s, b, '2026-11-05'));
  await eng.flush();
  const byBody = b => allCards(eng.doc(CURRENT)).find(c => c.body === b);
  for (const [s, b] of [['Armenian', 'a1'], ['English', 'e1'], ['General', 'g1']]) eng.add(rememberOp(s, byBody(b), '2026-11-05'));
  await eng.flush();
  assert.equal(totalCards(db), 4);
  const week = 'week/4-thu.md';
  const wk = b => allCards(eng.doc(week)).find(c => c.body === b);
  eng.add(archiveOp(week, 'Armenian', wk('a1'), DAY));
  eng.add(archiveOp(week, 'English', wk('e1'), DAY));
  eng.add(deleteOp(week, wk('g1').id));   // Forgot
  await eng.flush();
  assert.equal(totalCards(db), 3);
  assert.deepEqual(cards(db.text('archive/armenian/2026-11.md')).map(c => c.body), ['a1']);
  assert.deepEqual(cards(db.text('archive/english/2026-11.md')).map(c => c.body), ['e1']);
  assert.deepEqual(cards(db.text(week)), []);
  assert.deepEqual(cards(db.text(CURRENT)).map(c => c.body), ['a2']);
  assert.deepEqual(eng.paths('archive/'), ['archive/armenian/2026-11.md', 'archive/english/2026-11.md']);
});

test('archive file that exists in Dropbox but was never downloaded is appended to, not replaced', async () => {
  const db = fakeDropbox();
  db.put('archive/english/2026-11.md', '<!-- worddrill v1 -->\n\n## English\n\n<!-- card id=old -->\nolder word\n');
  db.put(WEEK, '<!-- worddrill v1 -->\n\n## English\n\n<!-- card id=n moved=2026-11-05 -->\nnew word\n');
  const eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);   // archive is listed but not downloaded
  assert.equal(eng.isLoaded('archive/english/2026-11.md'), false);
  eng.add(archiveOp(WEEK, 'English', allCards(eng.doc(WEEK))[0], DAY));
  await eng.flush();
  assert.deepEqual(ids(db.text('archive/english/2026-11.md')), ['old', 'n']);
});

test('archive file created on another device meanwhile (unknown to the listing) is merged', async () => {
  const db = fakeDropbox();
  db.put(WEEK, '## English\n<!-- card id=n -->\nnew word\n');
  const eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  db.put('archive/english/2026-11.md', '## English\n<!-- card id=other -->\nfrom phone\n');
  eng.add(archiveOp(WEEK, 'English', allCards(eng.doc(WEEK))[0], DAY));
  await eng.flush();
  assert.deepEqual(ids(db.text('archive/english/2026-11.md')), ['other', 'n']);
});

test('edit on one device while the card was remembered on another: text kept', async () => {
  const db = fakeDropbox();
  const a = createEngine({ api: db.api, storage: memStorage() }), b = createEngine({ api: db.api, storage: memStorage() });
  await a.sync(CORE);
  a.add(addOp(CURRENT, 'English', 'orig', DAY)); await a.flush();
  await b.sync(CORE);
  const card = allCards(a.doc(CURRENT))[0];
  a.add(rememberOp('English', card, DAY)); await a.flush();
  b.add(editOp(CURRENT, 'English', card, 'edited on B')); await b.flush();
  const all = [...db.files].filter(([p]) => p.endsWith('.md')).flatMap(([, f]) => cards(f.text).map(c => c.body));
  assert.ok(all.includes('edited on B'));
});

test('hand-edited file in Dropbox is picked up and its extra text survives a write', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  db.put(CURRENT, '## Armenian\nwritten by hand in Dropbox\n');
  const changed = await eng.sync(CORE);
  assert.ok(changed.includes(CURRENT));
  eng.add(addOp(CURRENT, 'English', 'via app', DAY));
  await eng.flush();
  assert.deepEqual(cards(db.text(CURRENT)).map(c => c.body), ['written by hand in Dropbox', 'via app']);
});

test('file deleted in Dropbox disappears locally', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  db.put(WEEK, '## English\n<!-- card id=x -->\nw\n');
  await eng.sync(CORE);
  assert.equal(allCards(eng.doc(WEEK)).length, 1);
  db.files.delete(WEEK);
  await eng.sync(CORE);
  assert.equal(allCards(eng.doc(WEEK)).length, 0);
});

test('weekly check done state syncs across devices', async () => {
  const db = fakeDropbox();
  const a = createEngine({ api: db.api, storage: memStorage() }), b = createEngine({ api: db.api, storage: memStorage() });
  await a.sync(CORE); await b.sync(CORE);
  assert.equal(b.state().weekCheckDone, undefined);
  a.add(stateOp('weekCheckDone', DAY));
  assert.equal(a.state().weekCheckDone, DAY);
  await a.flush();
  await b.sync(CORE);
  assert.equal(b.state().weekCheckDone, DAY);
  assert.equal(parseState(db.text('state.json')).weekCheckDone, DAY);
});

test('network failure during sync keeps everything for later', async () => {
  const db = fakeDropbox(), eng = createEngine({ api: db.api, storage: memStorage() });
  db.put(CURRENT, '## English\n<!-- card id=k -->\nkeep\n');
  await eng.sync(CORE);
  db.fail.push({ on: 'list' });
  await assert.rejects(eng.sync(CORE));
  assert.equal(allCards(eng.doc(CURRENT))[0].body, 'keep');
});

test('renaming an area rewrites the headings of existing files, creates no missing ones, survives a lost reply', async () => {
  const db = fakeDropbox();
  db.put(CURRENT, '<!-- worddrill v1 -->\n\n## Armenian\n\n<!-- card id=a -->\nalpha\n');
  db.put(WEEK, '<!-- worddrill v1 -->\n\n## Armenian\n\n<!-- card id=w moved=2026-11-05 -->\nweek\n');
  const eng = createEngine({ api: db.api, storage: memStorage() });
  await eng.sync(CORE);
  const plan = renameSectionPlan({}, 'armenian', 'Հայերեն', [CURRENT, 'prepared.md', ...WEEK_FILES], [eng.doc(CURRENT), eng.doc(WEEK)]);
  plan.ops.forEach(op => eng.add(op));
  db.fail.push({ on: 'upload', kind: 'after-write', path: WEEK });
  await assert.rejects(eng.flush());
  await eng.sync(CORE);
  assert.equal(eng.pending(), 0);
  assert.match(db.text(CURRENT), /## Հայերեն/);
  assert.match(db.text(WEEK), /## Հայերեն/);
  assert.equal(totalCards(db), 2);
  assert.equal(db.files.has('prepared.md'), false);
  assert.equal(db.files.has('week/1-mon.md'), false);
  assert.equal(parseState(db.text('state.json')).sections[0].name, 'Հայերեն');
});
