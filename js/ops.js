// Operations: every change is a small op kept in a queue until Dropbox has it.
// applyOp is pure and idempotent (applying an op twice = once), so an op can be replayed safely on
// the latest version of a file after a conflict or a lost response. A move writes its target file
// first and its source second, so a card can be briefly in two files but never in none.

import { weekFile, archiveFile } from './dates.js';
import { normalizeBody } from './format.js';

export const CURRENT = 'current.md';
export const STATE = 'state.json';
export const SECTIONS = [
  { key: 'armenian', name: 'Armenian' },
  { key: 'english', name: 'English' },
  { key: 'general', name: 'General' }
];
export const sectionKey = name => {
  const s = SECTIONS.find(x => x.name === name);
  if (s) return s.key;
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'other';
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
export const moveOp = (from, to, section, card, extraMeta, index) =>
  ({ type: 'move', from, to, section, card: { ...clone(card), meta: { ...card.meta, ...extraMeta } }, index });
export const rememberOp = (section, card, date) => moveOp(CURRENT, weekFile(date), section, card, { moved: date });
export const archiveOp = (fromPath, section, card, date) =>
  moveOp(fromPath, archiveFile(sectionKey(section), date), section, card, { archived: date });
export const stateOp = (key, value) => ({ type: 'state', key, value });

/* ---- Prepared list and daily targets ---- */
export const PREPARED = 'prepared.md';
// Cards per section to keep in Today; stored in state.json as "targets", edited in Settings
export const DEFAULT_TARGETS = { Armenian: 2, English: 2, General: 1 };
export function targetsOf(state) {
  const t = { ...DEFAULT_TARGETS };
  const saved = state && state.targets;
  if (saved && typeof saved === 'object')
    for (const [k, v] of Object.entries(saved)) if (Number.isInteger(v) && v >= 0) t[k] = v;
  return t;
}
const cardsIn = (doc, section) => (doc.sections.find(s => s.name === section) || { cards: [] }).cards;

/** Prepared → bottom of Today (button, regardless of the target) */
export const toTodayOp = (section, card, date) => moveOp(PREPARED, CURRENT, section, card, { started: date });
/** Today → top of Prepared, so it is the next card in line again */
export const toPreparedOp = (section, card) => moveOp(CURRENT, PREPARED, section, card, {}, 0);

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

/** Sections whose Prepared list holds less than one day's portion: [{ section, have, need }] */
export function preparedShortage(prepared, targets) {
  return Object.entries(targets)
    .filter(([, need]) => need > 0)
    .map(([section, need]) => ({ section, have: cardsIn(prepared, section).length, need }))
    .filter(x => x.have < x.need);
}

/** Files an op writes, in write order */
export const opTargets = op =>
  op.type === 'move' ? [op.to, op.from] : op.type === 'state' ? [STATE] : [op.path];

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
