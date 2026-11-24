// Operations: every change is a small op kept in a queue until Dropbox has it.
// applyOp is pure and idempotent (applying an op twice = once), so an op can be replayed safely on
// the latest version of a file after a conflict or a lost response. A move writes its target file
// first and its source second, so a card can be briefly in two files but never in none.

import { weekFile, archiveFile } from './dates.js';
import { normalizeBody } from './format.js';
import { HR_RE } from './markdown.js';
import { QUEUE_SECTION } from './queue.js';

export const CURRENT = 'current.md';
export const STATE = 'state.json';
// The areas (sections) used while state.json has no "sections" list
export const DEFAULT_SECTIONS = [
  { key: 'armenian', name: 'Armenian' },
  { key: 'english', name: 'English' },
  { key: 'general', name: 'General' }
];
export const SECTIONS = DEFAULT_SECTIONS;
const slug = name => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'other';
// key: the stable id of an area (its archive folder); name: the "## Name" heading in the files
export const sectionKey = (name, list = DEFAULT_SECTIONS) => {
  const s = list.find(x => x.name === name);
  return s ? s.key : slug(name);
};

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, x => (x % 36).toString(36)).join('') + Date.now().toString(36).slice(-3);
}

/* ---- builders ---- */
export const addOp = (path, section, body, date) =>
  ({ type: 'add', path, section, card: { id: newId(), meta: { added: date }, body: normalizeBody(body) } });
export const editOp = (path, section, card, body) =>
  ({ type: 'edit', path, section, id: card.id, meta: { ...card.meta }, body: normalizeBody(body) });
export const deleteOp = (path, id) => ({ type: 'delete', path, id });
// Restores a deleted card at its old position (Undo)
export const restoreOp = (path, section, card, index) => ({ type: 'add', path, section, card: clone(card), index });
export const orderOp = (path, section, ids) => ({ type: 'order', path, section, ids: [...ids] });
// index: position in the target section (Undo puts a card back where it was); default: at the end
// section: the section in the target file (the source loses the card wherever it is)
export const moveOp = (from, to, section, card, extraMeta, index) =>
  ({ type: 'move', from, to, section, card: { ...clone(card), meta: { ...card.meta, ...extraMeta } }, index });
export const rememberOp = (section, card, date) => moveOp(CURRENT, weekFile(date), section, card, { moved: date });
export const archiveOp = (fromPath, section, card, date, key = sectionKey(section)) =>
  moveOp(fromPath, archiveFile(key, date), section, card, { archived: date });
export const stateOp = (key, value) => ({ type: 'state', key, value });
/** Moves a card to another section of the same file (at index; default: the end) */
export const sectionOp = (path, id, section, index) => ({ type: 'section', path, id, section, index });

/* ---- Prepared list and daily targets ---- */
export const PREPARED = 'prepared.md';
// Cards per section to keep in Today; stored in state.json as "targets", edited in Settings
export const DEFAULT_TARGETS = { Armenian: 2, English: 2, General: 1 };
// Only the active areas count; a saved value wins, an area without one has its default (0 for a new area)
export function targetsOf(state) {
  const saved = state && state.targets && typeof state.targets === 'object' ? state.targets : {};
  const t = {};
  for (const { name } of activeSections(state)) {
    const v = saved[name];
    t[name] = Number.isInteger(v) && v >= 0 ? v : DEFAULT_TARGETS[name] ?? 0;
  }
  return t;
}

/* ---- Areas (sections): state.json "sections" = [{ key, name, removed? }] ---- */
// A removed area keeps its entry (removed = date): its archive keeps the name, and it can come back.
// The key never changes (it names the archive folder); a rename changes the "## Name" headings.
export function sectionsList(state) {
  const saved = state && state.sections;
  if (!Array.isArray(saved)) return DEFAULT_SECTIONS.map(s => ({ ...s }));
  const out = [];
  for (const s of saved) {
    if (!s || typeof s !== 'object' || typeof s.key !== 'string' || !s.key || typeof s.name !== 'string' || !s.name.trim()) continue;
    if (out.some(x => x.key === s.key || x.name === s.name)) continue;
    out.push({ ...s });
  }
  if (out.some(s => !s.removed)) return out;
  // Broken or empty list: the default areas come back, nothing is hidden
  return DEFAULT_SECTIONS.map(s => ({ ...s })).concat(out.filter(s => !DEFAULT_SECTIONS.some(d => d.key === s.key || d.name === s.name)));
}
export const activeSections = state => sectionsList(state).filter(s => !s.removed);
export const cleanName = name => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const savedOr = (state, k) => (state && state[k] !== undefined ? state[k] : null);

/** Renames the heading "## from" to "## to" in the given files (merges into "to" if it is there already) */
export const renameOp = (paths, from, to) => ({ type: 'rename', paths: [...paths], from, to });

/*
 * The area plans return { ops, undo, message } or { error }. paths: the files that hold cards of the
 * areas (Today, Prepared, the weekday files); docs: those files' docs. Archive files are not touched:
 * the archive is found by the key, so its old headings stay as history.
 */
export function addSectionPlan(state, rawName, extraKeys = []) {
  const name = cleanName(rawName), list = sectionsList(state);
  if (!name) return { error: 'Type a name first.' };
  const same = list.find(s => sameName(s.name, name));
  if (same && !same.removed) return { error: 'There is already an area called ' + same.name + '.' };
  const undo = [stateOp('sections', savedOr(state, 'sections'))];
  if (same) {   // a removed area comes back, with its archive
    const next = list.map(s => { if (s !== same) return s; const c = { ...s }; delete c.removed; return c; });
    return { ops: [stateOp('sections', next)], undo, message: 'Area ' + same.name + ' is back.' };
  }
  const used = new Set(list.map(s => s.key).concat(extraKeys));
  let key = slug(name), n = 2;
  while (used.has(key)) key = slug(name) + '-' + n++;
  const targets = state && state.targets && typeof state.targets === 'object' ? state.targets : {};
  return {
    ops: [stateOp('sections', list.concat({ key, name })), stateOp('targets', { ...targets, [name]: 1 })],
    undo: undo.concat(stateOp('targets', savedOr(state, 'targets'))),
    message: 'Area ' + name + ' added.'
  };
}

export function renameSectionPlan(state, key, rawName, paths, docs) {
  const name = cleanName(rawName), list = sectionsList(state);
  const area = list.find(s => s.key === key);
  if (!area) return { error: 'No such area.' };
  if (!name) return { error: 'Type a name first.' };
  if (name === area.name) return { error: null };
  const clash = list.find(s => s !== area && sameName(s.name, name));
  if (clash) return { error: 'There is already ' + (clash.removed ? 'a removed area' : 'an area') + ' called ' + clash.name + '.' };
  if (docs.some(d => d.sections.some(s => s.name === name && s.cards.length)))
    return { error: 'Some cards are already under the heading ' + name + '. Move them first or pick another name.' };
  const ops = [renameOp(paths, area.name, name), stateOp('sections', list.map(s => s === area ? { ...s, name } : s))];
  const undo = [renameOp(paths, name, area.name), stateOp('sections', savedOr(state, 'sections'))];
  // the target goes with the area (also a default one: a default belongs to the old name only)
  const targets = state && state.targets && typeof state.targets === 'object' ? state.targets : {};
  const moved = { ...targets, [name]: targetsOf(state)[area.name] ?? 0 };
  delete moved[area.name];
  ops.push(stateOp('targets', moved));
  undo.push(stateOp('targets', savedOr(state, 'targets')));
  return { ops, undo, message: area.name + ' renamed to ' + name + '.' };
}

/** Removes an area from the lists, only when Today, Prepared and the weekday files hold none of its cards */
export function removeSectionPlan(state, key, docs, date, queueFileCount = 0) {
  const list = sectionsList(state);
  const area = list.find(s => s.key === key && !s.removed);
  if (!area) return { error: 'No such area.' };
  if (list.filter(s => !s.removed).length < 2) return { error: 'At least one area must stay.' };
  const n = docs.reduce((k, d) => k + (d.sections.find(s => s.name === area.name) || { cards: [] }).cards.length, 0);
  if (n) return { error: area.name + ' still has ' + n + (n === 1 ? ' card' : ' cards') + ' in Today, Preparation or the weekly check. Move them to another area (⋯ → Move to…) or delete them first.' };
  if (queueFileCount) return { error: area.name + ' still has cards in its queue. Move them to Preparation or delete them first.' };
  return {
    ops: [stateOp('sections', list.map(s => s === area ? { ...s, removed: date } : s))],
    undo: [stateOp('sections', savedOr(state, 'sections'))],
    message: 'Area ' + area.name + ' removed. Its archive stays.'
  };
}

/** Moves an area one place up (dir -1) or down (dir 1) */
export function moveSectionPlan(state, key, dir) {
  const list = sectionsList(state);
  const active = list.filter(s => !s.removed);
  const i = active.findIndex(s => s.key === key), j = i + dir;
  if (i < 0 || j < 0 || j >= active.length) return { error: null };
  [active[i], active[j]] = [active[j], active[i]];
  return { ops: [stateOp('sections', active.concat(list.filter(s => s.removed)))], undo: [stateOp('sections', savedOr(state, 'sections'))] };
}

/* ---- Split and merge ---- */
// Merged cards are separated by a horizontal line (---)
export const JOIN = '\n\n---\n\n';
// The separator line at the edge of a split part goes (it separated the two cards)
const dropEdgeRule = (body, atEnd) => {
  const lines = body.split('\n');
  if (HR_RE.test(lines[atEnd ? lines.length - 1 : 0])) { if (atEnd) lines.pop(); else lines.shift(); }
  return normalizeBody(lines.join('\n'));
};
/**
 * Splits a card at pos of text (the editor's text): the part before stays in the card, the part after
 * becomes a new card right below with the same meta (so it is due in the same weekly check). null if a
 * part would be empty.
 */
export function splitPlan(path, section, card, index, text, pos) {
  // spaces at the cut go too (a split between two words leaves no space at the edges)
  const a = dropEdgeRule(normalizeBody(text.slice(0, pos).replace(/[ \t]+$/, '')), true);
  const b = dropEdgeRule(normalizeBody(text.slice(pos).replace(/^[ \t]+/, '')), false);
  if (!a || !b) return null;
  const fresh = { id: newId(), meta: { ...card.meta }, body: b };
  return {
    // the new card first: an interrupted split leaves the text twice, never lost
    ops: [{ type: 'add', path, section, card: fresh, index: index + 1 }, editOp(path, section, card, a)],
    undo: [editOp(path, section, card, card.body), deleteOp(path, fresh.id)],
    card: fresh
  };
}
/** Joins a card with the one below: the upper card gets both texts, the lower one is deleted */
export function mergePlan(path, section, upper, lower, lowerIndex) {
  return {
    // edit first: an interrupted merge leaves the text twice, never lost
    ops: [editOp(path, section, upper, normalizeBody(upper.body) + JOIN + normalizeBody(lower.body)), deleteOp(path, lower.id)],
    undo: [restoreOp(path, section, lower, lowerIndex), editOp(path, section, upper, upper.body)]
  };
}
const cardsIn = (doc, section) => (doc.sections.find(s => s.name === section) || { cards: [] }).cards;

/** Prepared → bottom of Today (button, regardless of the target) */
export const toTodayOp = (section, card, date) => moveOp(PREPARED, CURRENT, section, card, { started: date });
/** Today → top of Prepared, so it is the next card in line again */
export const toPreparedOp = (section, card) => moveOp(CURRENT, PREPARED, section, card, {}, 0);

/** A card remembered by mistake: weekday file → bottom of Today, without its `moved` date */
export function backToTodayOp(fromPath, section, card) {
  const meta = { ...card.meta };
  delete meta.moved;
  return moveOp(fromPath, CURRENT, section, { ...card, meta });
}

/**
 * ✓ Remembered: the card goes to today's weekday file; cards below it move up. If that leaves the
 * section below its target, the top Prepared card of the same section joins Today at the bottom.
 * Returns { ops, undo, refill } — undo puts both cards back where they were.
 */
export function rememberPlan(current, prepared, section, card, date, target) {
  const cards = cardsIn(current, section);
  const index = cards.findIndex(c => c.id === card.id);
  const ops = [rememberOp(section, card, date)];
  const undo = [];
  const next = cardsIn(prepared, section)[0];
  const refill = next && cards.length - 1 < target ? next : null;
  if (refill) {
    ops.push(toTodayOp(section, refill, date));
    undo.push(moveOp(CURRENT, PREPARED, section, refill, {}, 0));
  }
  undo.push(moveOp(weekFile(date), CURRENT, section, card, {}, index));
  return { ops, undo, refill };
}

/* ---- The queue (queue/<key>/NNNN.md, see queue.js): targets are { path, index } ---- */
/** A new card in the queue at target (soon or the end) */
export const queueAddOp = (target, body, date) => ({ ...addOp(target.path, QUEUE_SECTION, body, date), index: target.index });
/** Queue → bottom of the area in Preparation (the end of the line); Undo puts it back in its place */
export function queueToPreparedPlan(qPath, area, card, index) {
  return { ops: [moveOp(qPath, PREPARED, area, card)], undo: [moveOp(PREPARED, qPath, QUEUE_SECTION, card, {}, index)], message: 'Moved to Preparation.' };
}
/** Postpones a queue card to the end of the queue (target: appendTarget); doc: its file's doc */
export function queueToEndPlan(doc, qPath, card, index, target) {
  if (target.path === qPath) {
    const ids = cardsIn(doc, QUEUE_SECTION).map(c => c.id);
    return {
      ops: [orderOp(qPath, QUEUE_SECTION, ids.filter(id => id !== card.id).concat(card.id))],
      undo: [orderOp(qPath, QUEUE_SECTION, ids)], message: 'Moved to the end of the queue.'
    };
  }
  return { ops: [moveOp(qPath, target.path, QUEUE_SECTION, card, {}, target.index)], undo: [moveOp(target.path, qPath, QUEUE_SECTION, card, {}, index)], message: 'Moved to the end of the queue.' };
}
/**
 * Forgot in the weekly check: the card goes back into its area's queue at target (the "soon" place),
 * without its moved date and with forgot=date. The queue file is written first, so it can't be lost.
 */
export function forgotPlan(weekPath, section, card, index, target, date) {
  const meta = { ...card.meta, forgot: date };
  delete meta.moved;
  return {
    ops: [moveOp(weekPath, target.path, QUEUE_SECTION, { ...card, meta }, {}, target.index)],
    undo: [moveOp(target.path, weekPath, section, card, {}, index)],
    message: 'Back in the queue: it comes up again soon.'
  };
}
/** Sections whose Prepared list holds less than one day's portion: [{ section, have, need }] */
export function preparedShortage(prepared, targets) {
  return Object.entries(targets)
    .filter(([, need]) => need > 0)
    .map(([section, need]) => ({ section, have: cardsIn(prepared, section).length, need }))
    .filter(x => x.have < x.need);
}

/** Files an op writes, in write order */
export const opTargets = op =>
  op.type === 'move' ? [op.to, op.from] : op.type === 'state' ? [STATE] : op.type === 'rename' ? [...(op.paths || [])] : [op.path];

/* ---- applying ---- */
const clone = o => JSON.parse(JSON.stringify(o));

export function findCard(doc, id) {
  for (const section of doc.sections) {
    const index = section.cards.findIndex(c => c.id === id);
    if (index >= 0) return { section, index, card: section.cards[index] };
  }
  return null;
}

export function ensureSection(doc, name) {
  let s = doc.sections.find(x => x.name === name);
  if (s) return s;
  s = { name, cards: [] };
  const order = SECTIONS.map(x => x.name), idx = order.indexOf(name);
  const at = idx < 0 ? -1 : doc.sections.findIndex(x => order.indexOf(x.name) > idx);
  if (at < 0) doc.sections.push(s); else doc.sections.splice(at, 0, s);
  return s;
}

function addCard(doc, sectionName, card, index) {
  if (findCard(doc, card.id)) return;
  const s = ensureSection(doc, sectionName);
  const c = clone(card);
  if (index == null || index > s.cards.length) s.cards.push(c); else s.cards.splice(Math.max(0, index), 0, c);
}
function removeCard(doc, id) {
  const f = findCard(doc, id);
  if (f) f.section.cards.splice(f.index, 1);
}

/** Returns a new doc with op applied to the file at path (unchanged if op doesn't touch it) */
export function applyOp(op, path, doc) {
  if (!opTargets(op).includes(path) || op.type === 'state') return doc;
  const d = clone(doc);
  switch (op.type) {
    case 'add': addCard(d, op.section, op.card, op.index); break;
    case 'edit': {
      const f = findCard(d, op.id);
      // The card is gone from this file (moved or deleted elsewhere): keep the edited text anyway
      if (f) f.card.body = op.body; else addCard(d, op.section, { id: op.id, meta: op.meta || {}, body: op.body });
      break;
    }
    case 'delete': removeCard(d, op.id); break;
    case 'order': {
      const s = d.sections.find(x => x.name === op.section);
      if (s) {
        const pos = new Map(op.ids.map((id, i) => [id, i]));
        const known = s.cards.filter(c => pos.has(c.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
        s.cards = known.concat(s.cards.filter(c => !pos.has(c.id)));
      }
      break;
    }
    case 'section': {
      const f = findCard(d, op.id);
      if (f && f.section.name !== op.section) {
        f.section.cards.splice(f.index, 1);
        const s = ensureSection(d, op.section);
        if (op.index == null || op.index > s.cards.length) s.cards.push(f.card);
        else s.cards.splice(Math.max(0, op.index), 0, f.card);
      }
      break;
    }
    case 'rename': {
      const from = d.sections.find(x => x.name === op.from);
      if (!from || op.from === op.to) return doc;
      const to = d.sections.find(x => x.name === op.to);
      if (!to) from.name = op.to;
      else {
        for (const c of from.cards) if (!to.cards.some(x => x.id === c.id)) to.cards.push(c);
        d.sections.splice(d.sections.indexOf(from), 1);
      }
      break;
    }
    case 'move':
      if (path === op.to) addCard(d, op.section, op.card, op.index);
      else removeCard(d, op.card.id);
      break;
    default: return doc;   // unknown op from a newer release: leave the file alone
  }
  return d;
}

export function applyStateOp(op, state) {
  if (op.type !== 'state') return state;
  return { ...state, [op.key]: op.value };
}

/** Number of cards an op is allowed to remove overall (for tests and safety checks) */
export const removes = op => (op.type === 'delete' ? 1 : 0);
