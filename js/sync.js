// Sync engine: a local copy of the Dropbox files plus a queue of pending ops.
// What the UI shows = the last known Dropbox text of a file + the pending ops applied to it.
// flush() writes ops in order: for each file an op touches it applies the op to the latest known
// text and uploads with that text's rev. A run of ops that all touch one and the same file (say, a card
// split into 300) is applied together and uploaded once. A conflict (the file changed elsewhere) downloads the
// newer text and replays the op on it — ops are idempotent, so nothing is lost or doubled.
// An op leaves the queue only after every file it touches is saved in Dropbox.
//
// api: { list() → [{ path, rev }], download(path) → { text, rev } | null, upload(path, text, rev|null) → { rev } }
//   upload with rev = null must fail with err.conflict if the file exists; with a rev — if it differs.
//   remove(path, rev): deletes the file only at that rev (else err.conflict); a missing file is fine.
// storage: { get(key), set(key, value) } (localStorage JSON wrapper in the app, a Map in tests)

import { parseDoc, serializeDoc, parseState, serializeState, allCards } from './format.js';
import { opTargets, applyOp, applyStateOp, STATE } from './ops.js';
import { isQueueFile } from './queue.js';

const MAX_CONFLICT_RETRIES = 5;

export function createEngine({ api, storage, key = 'wd.data' }) {
  const data = storage.get(key) || {};
  data.files = data.files || {};   // path → { text: string|null, rev: string|null, remoteRev: string|null|undefined }
  data.ops = data.ops || [];
  data.seq = data.seq || 0;
  const save = () => storage.set(key, data);
  let chain = Promise.resolve();
  const exclusive = fn => (chain = chain.catch(() => {}).then(fn));

  const fileOf = path => (data.files[path] = data.files[path] || { text: null, rev: null, remoteRev: undefined });
  const baseText = path => (data.files[path] && data.files[path].text) || '';
  const isState = path => path === STATE;

  /** Doc with pending ops applied — what the UI shows */
  function doc(path) {
    let d = parseDoc(baseText(path));
    for (const op of data.ops) if (opTargets(op).includes(path)) d = applyOp(op, path, d);
    return d;
  }
  function state() {
    let s = parseState(baseText(STATE));
    for (const op of data.ops) s = applyStateOp(op, s);
    return s;
  }
  function add(op) {
    op.opId = ++data.seq;
    data.ops.push(op);
    save();
    return op;
  }
  /** Paths that exist in Dropbox or locally, starting with prefix */
  const paths = prefix => Object.keys(data.files)
    .filter(p => p.startsWith(prefix) && (data.files[p].remoteRev || (data.files[p].text || '').trim()))
    .concat(data.ops.flatMap(opTargets).filter(p => p.startsWith(prefix)))
    .filter((p, i, a) => a.indexOf(p) === i).sort();
  const isLoaded = path => !!data.files[path] && data.files[path].text != null;

  // Makes the local text of path the latest version Dropbox reported; true if it changed
  async function load(path) {
    const f = fileOf(path);
    if (f.text != null && f.rev === f.remoteRev) return false;
    if (f.remoteRev === null) { const changed = f.text !== ''; f.text = ''; f.rev = null; save(); return changed; }
    const d = await api.download(path);
    const before = f.text;
    if (!d) { f.text = ''; f.rev = null; f.remoteRev = null; }
    else { f.text = d.text; f.rev = f.remoteRev = d.rev; }
    save();
    return before !== f.text;
  }

  // Reads the folder listing and downloads the given files (plus any already loaded) if they changed
  async function pull(wanted) {
    const list = await api.list();
    const seen = new Set();
    for (const e of list) { seen.add(e.path); fileOf(e.path).remoteRev = e.rev; }
    for (const [p, f] of Object.entries(data.files)) if (!seen.has(p)) f.remoteRev = null;
    save();
    const changed = [];
    const toLoad = new Set([...wanted, ...Object.keys(data.files).filter(isLoaded)]);
    for (const p of toLoad) if (await load(p)) changed.push(p);
    return changed;
  }

  // ops: applied in order to path's latest text, then one upload
  async function writeOps(ops, path) {
    for (let attempt = 0; ; attempt++) {
      await load(path);
      const f = fileOf(path);
      let before, next;
      if (isState(path)) {
        const s = parseState(f.text);
        before = serializeState(s); next = serializeState(ops.reduce((x, op) => applyStateOp(op, x), s));
      } else {
        const d = parseDoc(f.text);
        before = serializeDoc(d); next = serializeDoc(ops.reduce((x, op) => applyOp(op, path, x), d));
      }
      if (next === before) return;   // already applied (a replay) — nothing to write
      try {
        // A queue file left without cards is deleted — only the version these ops were applied to
        // (another device's new card makes it a conflict: re-download, replay, keep the file)
        if (isQueueFile(path) && !allCards(parseDoc(next)).length) {
          if (f.rev) await api.remove(path, f.rev);
          f.text = ''; f.rev = null; f.remoteRev = null;
          save();
          return;
        }
        const r = await api.upload(path, next, f.rev);
        f.text = next; f.rev = f.remoteRev = r.rev;
        save();
        return;
      } catch (e) {
        if (!e.conflict || attempt >= MAX_CONFLICT_RETRIES) throw e;
        f.remoteRev = undefined;   // re-download and replay
      }
    }
  }

  async function flushNow() {
    while (data.ops.length) {
      const targets = opTargets(data.ops[0]);
      let n = 1;
      // the ops right after it that touch only the same single file go in the same upload
      if (targets.length === 1) {
        while (n < data.ops.length) {
          const t = opTargets(data.ops[n]);
          if (t.length !== 1 || t[0] !== targets[0]) break;
          n++;
        }
      }
      const ops = data.ops.slice(0, n);
      for (const path of targets) await writeOps(ops, path);
      data.ops.splice(0, n);
      save();
    }
  }

  return {
    data, doc, state, add, paths, isLoaded,
    pending: () => data.ops.length,
    flush: () => exclusive(flushNow),
    load: path => exclusive(() => load(path)),
    /** Writes pending ops, then fetches what changed elsewhere. Returns changed paths. */
    sync: wanted => exclusive(async () => {
      await flushNow();
      const changed = await pull(wanted);
      await flushNow();
      return changed;
    })
  };
}
