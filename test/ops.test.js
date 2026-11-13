import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, serializeDoc, allCards } from '../js/format.js';
import {
  applyOp, opTargets, addOp, editOp, deleteOp, restoreOp, orderOp, rememberOp, archiveOp, stateOp, applyStateOp,
  CURRENT, ensureSection, sectionKey,
  PREPARED, DEFAULT_TARGETS, targetsOf, rememberPlan, toTodayOp, toPreparedOp, preparedShortage, backToTodayOp
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

/* ---- Prepared list ---- */
const prep = () => parseDoc('## Armenian\n<!-- card id=p1 -->\nnext one\n<!-- card id=p2 -->\nlater\n## General\n<!-- card id=pg -->\ng');
const run = (ops, files) => ops.reduce((f, op) => apply(op, f), files);

test('remember refills from the top of Prepared when Today drops below the target', () => {
  const files = { [CURRENT]: cur(), [PREPARED]: prep() };
  const card = allCards(files[CURRENT])[0];   // a — Armenian has a, b
  const plan = rememberPlan(files[CURRENT], files[PREPARED], 'Armenian', card, '2026-11-12', 2);
  assert.equal(plan.refill.id, 'p1');
  const after = run(plan.ops, files);
  assert.deepEqual(after[CURRENT].sections[0].cards.map(c => c.id), ['b', 'p1']);   // b moved up, p1 at the bottom
  assert.equal(after[CURRENT].sections[0].cards[1].meta.started, '2026-11-12');
  assert.deepEqual(ids(after[PREPARED]), ['p2', 'pg']);
  assert.equal(total(after), total(files));
  // Undo restores everything exactly
  const back = run(plan.undo, after);
  assert.deepEqual(back[CURRENT].sections[0].cards.map(c => c.id), ['a', 'b']);
  assert.deepEqual(ids(back[PREPARED]), ['p1', 'p2', 'pg']);
  assert.equal(total(back), total(files));
});

test('no refill when Today still meets the target, or Prepared is empty', () => {
  const three = applyOp(addOp(CURRENT, 'Armenian', 'third', '2026-11-12'), CURRENT, cur());
  const card = allCards(three)[0];
  assert.equal(rememberPlan(three, prep(), 'Armenian', card, '2026-11-12', 2).refill, null);
  const plan = rememberPlan(cur(), prep(), 'English', { id: 'zz' }, '2026-11-12', 2);
  assert.equal(plan.refill, null);
  assert.equal(plan.ops.length, 1);
});

test('push to Today and back to Prepared', () => {
  const files = { [CURRENT]: cur(), [PREPARED]: prep() };
  const p2 = allCards(files[PREPARED])[1];
  let f = apply(toTodayOp('Armenian', p2, '2026-11-12'), files);
  assert.deepEqual(f[CURRENT].sections[0].cards.map(c => c.id), ['a', 'b', 'p2']);
  const a = allCards(f[CURRENT])[0];
  f = apply(toPreparedOp('Armenian', a), f);
  assert.deepEqual(f[PREPARED].sections[0].cards.map(c => c.id), ['a', 'p1']);
  assert.equal(total(f), total(files));
});

test('a card remembered by mistake goes back to Today without its moved date', () => {
  const files = { [CURRENT]: cur() };
  const card = allCards(files[CURRENT])[0];
  let f = apply(rememberOp('Armenian', card, '2026-11-12'), files);
  const inWeek = allCards(f['week/4-thu.md'])[0];
  f = apply(backToTodayOp('week/4-thu.md', 'Armenian', inWeek), f);
  assert.equal(allCards(f['week/4-thu.md']).length, 0);
  const back = f[CURRENT].sections[0].cards.find(c => c.id === card.id);
  assert.deepEqual(back.meta, { added: '2026-11-01' });
  assert.equal(total(f), total(files));
});

test('daily targets and Prepared shortage', () => {
  assert.deepEqual(targetsOf({}), DEFAULT_TARGETS);
  assert.deepEqual(targetsOf({ targets: { English: 3, General: -1, Armenian: 'x' } }), { Armenian: 2, English: 3, General: 1 });
  assert.deepEqual(preparedShortage(prep(), DEFAULT_TARGETS), [
    { section: 'English', have: 0, need: 2 }, { section: 'General', have: 1, need: 1 }
  ].filter(x => x.have < x.need));
  assert.deepEqual(preparedShortage(prep(), { Armenian: 2, English: 0, General: 1 }), []);
});

test('sections', () => {
  const d = parseDoc('## General\n<!-- card id=g -->\ng');
  ensureSection(d, 'Armenian'); ensureSection(d, 'Custom'); ensureSection(d, 'English');
  assert.deepEqual(d.sections.map(s => s.name), ['Armenian', 'English', 'General', 'Custom']);
  assert.equal(sectionKey('Armenian'), 'armenian');
  assert.equal(sectionKey('Phrasal verbs!'), 'phrasal-verbs');
});
