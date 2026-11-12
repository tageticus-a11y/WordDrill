import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, serializeDoc, allCards } from '../js/format.js';
import {
  applyOp, opTargets, addOp, editOp, deleteOp, restoreOp, orderOp, rememberOp, archiveOp, stateOp, applyStateOp,
  CURRENT, ensureSection, sectionKey
} from '../js/ops.js';

const cur = () => parseDoc('<!-- worddrill v1 -->\n\n## Armenian\n\n<!-- card id=a added=2026-11-01 -->\nalpha\n\n<!-- card id=b -->\nbeta\n\n## General\n\n<!-- card id=c -->\ngamma\n');
const ids = d => allCards(d).map(c => c.id);
const apply = (op, files) => {
  const out = { ...files };
  for (const p of opTargets(op)) out[p] = applyOp(op, p, out[p] || parseDoc(''));
  return out;
};
const total = files => Object.values(files).reduce((n, d) => n + allCards(d).length, 0);

test('add puts the card in its section, in canonical section order', () => {
  const op = addOp(CURRENT, 'English', '  \nnew word\n\n', '2026-11-12');
  const d = applyOp(op, CURRENT, cur());
  assert.deepEqual(d.sections.map(s => s.name), ['Armenian', 'English', 'General']);
  assert.equal(d.sections[1].cards[0].body, 'new word');
  assert.equal(d.sections[1].cards[0].meta.added, '2026-11-12');
});

test('every op is idempotent', () => {
  const base = cur();
  const card = allCards(base)[0];
  const ops = [
    addOp(CURRENT, 'Armenian', 'x', '2026-11-12'), editOp(CURRENT, 'Armenian', card, 'edited'),
    deleteOp(CURRENT, 'b'), orderOp(CURRENT, 'Armenian', ['b', 'a']), rememberOp('Armenian', card, '2026-11-12'),
    restoreOp(CURRENT, 'Armenian', card, 0)
  ];
  for (const op of ops) for (const p of opTargets(op)) {
    const once = applyOp(op, p, base);
    assert.deepEqual(applyOp(op, p, once), once, op.type + ' on ' + p);
  }
});

test('applyOp does not mutate its input', () => {
  const base = cur(), snap = JSON.stringify(base);
  applyOp(deleteOp(CURRENT, 'a'), CURRENT, base);
  applyOp(orderOp(CURRENT, 'Armenian', ['b', 'a']), CURRENT, base);
  assert.equal(JSON.stringify(base), snap);
});

test('remember moves a card from current to today\'s weekday file, keeping the count', () => {
  const files = { [CURRENT]: cur() };
  const card = allCards(files[CURRENT])[0];
  const op = rememberOp('Armenian', card, '2026-11-12');
  assert.deepEqual(opTargets(op), ['week/4-thu.md', CURRENT]);   // target first
  const after = apply(op, files);
  assert.equal(total(after), total(files));
  assert.deepEqual(ids(after[CURRENT]), ['b', 'c']);
  const moved = allCards(after['week/4-thu.md'])[0];
  assert.equal(moved.body, 'alpha');
  assert.deepEqual(moved.meta, { added: '2026-11-01', moved: '2026-11-12' });
});

test('a move interrupted after the first file keeps the card (duplicated, never lost)', () => {
  const files = { [CURRENT]: cur() };
  const op = rememberOp('Armenian', allCards(files[CURRENT])[0], '2026-11-12');
  const [first, second] = opTargets(op);
  const half = { ...files, [first]: applyOp(op, first, parseDoc('')) };
  assert.ok(total(half) >= total(files));
  // Replaying the whole op after the interruption finishes it with the right count
  const done = apply(op, half);
  assert.equal(total(done), total(files));
  assert.ok(second === CURRENT && !ids(done[CURRENT]).includes('a'));
});

test('archive moves from a weekday file to the section\'s month file', () => {
  const week = parseDoc('## English\n<!-- card id=e moved=2026-11-05 -->\nword');
  const card = allCards(week)[0];
  const op = archiveOp('week/4-thu.md', 'English', card, '2026-11-12');
  assert.equal(op.to, 'archive/english/2026-11.md');
  const after = apply(op, { 'week/4-thu.md': week });
  assert.equal(allCards(after['week/4-thu.md']).length, 0);
  const a = allCards(after['archive/english/2026-11.md'])[0];
  assert.equal(a.meta.archived, '2026-11-12');
  assert.equal(a.meta.moved, '2026-11-05');
});

test('edit of a card that disappeared re-adds it rather than losing the text', () => {
  const card = allCards(cur())[0];
  const op = editOp(CURRENT, 'Armenian', card, 'my edit');
  const gone = applyOp(deleteOp(CURRENT, 'a'), CURRENT, cur());
  const d = applyOp(op, CURRENT, gone);
  assert.equal(allCards(d).find(c => c.id === 'a').body, 'my edit');
});

test('order keeps cards unknown to the op', () => {
  let d = applyOp(addOp(CURRENT, 'Armenian', 'from another device', '2026-11-12'), CURRENT, cur());
  d = applyOp(orderOp(CURRENT, 'Armenian', ['b', 'a']), CURRENT, d);
  assert.equal(d.sections[0].cards.length, 3);
  assert.deepEqual(d.sections[0].cards.slice(0, 2).map(c => c.id), ['b', 'a']);
});

test('restore puts a deleted card back at its position', () => {
  const base = cur(), card = allCards(base)[0];
  const d = applyOp(restoreOp(CURRENT, 'Armenian', card, 0), CURRENT, applyOp(deleteOp(CURRENT, 'a'), CURRENT, base));
  assert.deepEqual(serializeDoc(d), serializeDoc(base));
});

test('unknown op types leave files untouched', () => {
  const base = cur();
  assert.equal(applyOp({ type: 'future-thing', path: CURRENT }, CURRENT, base), base);
});

test('state ops', () => {
  assert.deepEqual(applyStateOp(stateOp('weekCheckDone', '2026-11-12'), { other: 1 }), { other: 1, weekCheckDone: '2026-11-12' });
  assert.deepEqual(opTargets(stateOp('k', 1)), ['state.json']);
});

test('sections', () => {
  const d = parseDoc('## General\n<!-- card id=g -->\ng');
  ensureSection(d, 'Armenian'); ensureSection(d, 'Custom'); ensureSection(d, 'English');
  assert.deepEqual(d.sections.map(s => s.name), ['Armenian', 'English', 'General', 'Custom']);
  assert.equal(sectionKey('Armenian'), 'armenian');
  assert.equal(sectionKey('Phrasal verbs!'), 'phrasal-verbs');
});
