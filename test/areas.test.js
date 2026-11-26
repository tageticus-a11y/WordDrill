import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, serializeDoc, allCards } from '../js/format.js';
import {
  applyOp, applyStateOp, opTargets, CURRENT, PREPARED, DEFAULT_SECTIONS, sectionsList, activeSections, targetsOf,
  addSectionPlan, renameSectionPlan, removeSectionPlan, moveSectionPlan, renameOp, splitPlan, splitAllPlan, coverage, coverageText, minCoverage, splitParts, mergePlan, archiveOp, JOIN
} from '../js/ops.js';

const WEEK = 'week/1-mon.md';
const PATHS = [CURRENT, PREPARED, WEEK];
const text = {
  [CURRENT]: '<!-- worddrill v1 -->\n\n## Armenian\n\n<!-- card id=a added=2026-11-01 -->\nalpha\n\n<!-- card id=b -->\nbeta\n\n## General\n\n<!-- card id=c -->\ngamma\n',
  [PREPARED]: '<!-- worddrill v1 -->\n\n## Armenian\n\n<!-- card id=p -->\nnext one\n',
  [WEEK]: '<!-- worddrill v1 -->\n\n## English\n\n<!-- card id=w moved=2026-11-16 -->\nweek card\n'
};
const files = () => Object.fromEntries(PATHS.map(p => [p, parseDoc(text[p])]));
// Applies ops to files and state the way the sync engine does
function run(ops, f, state) {
  let s = state;
  const out = { ...f };
  for (const op of ops) {
    if (op.type === 'state') { s = applyStateOp(op, s); continue; }
    for (const p of opTargets(op)) out[p] = applyOp(op, p, out[p] || parseDoc(''));
  }
  return { files: out, state: s };
}
const count = f => Object.values(f).reduce((n, d) => n + allCards(d).length, 0);
const names = d => d.sections.map(s => s.name);

test('areas: the defaults until state.json has a list; broken entries are skipped', () => {
  assert.deepEqual(sectionsList({}), DEFAULT_SECTIONS);
  assert.deepEqual(sectionsList({ sections: [{ key: 'x', name: 'X' }, { key: 'x', name: 'Y' }, { name: 'no key' }, null] }), [{ key: 'x', name: 'X' }]);
  // Nothing active (or an empty list): the defaults come back, so no cards are hidden
  assert.deepEqual(activeSections({ sections: [] }).map(s => s.key), ['armenian', 'english', 'general']);
  assert.deepEqual(targetsOf({ sections: [{ key: 'armenian', name: 'Armenian' }, { key: 'idioms', name: 'Idioms' }] }), { Armenian: 2, Idioms: 0 });
});

test('add an area: a new key and a target of 1; a removed area comes back with its key', () => {
  const p = addSectionPlan({}, '  Phrasal   verbs ');
  const { state } = run(p.ops, {}, {});
  assert.deepEqual(activeSections(state).map(s => s.name), ['Armenian', 'English', 'General', 'Phrasal verbs']);
  assert.equal(activeSections(state)[3].key, 'phrasal-verbs');
  assert.equal(targetsOf(state)['Phrasal verbs'], 1);
  assert.match(addSectionPlan(state, 'phrasal VERBS').error, /already/);
  assert.equal(addSectionPlan({}, 'Armenian', []).error.includes('already'), true);
  // a key that an archive folder already uses is not reused
  const k = run(addSectionPlan({}, 'Idioms', ['idioms']).ops, {}, {}).state;
  assert.equal(activeSections(k)[3].key, 'idioms-2');
  // Undo restores the state exactly
  assert.deepEqual(run(p.undo, {}, state).state, { sections: null, targets: null });
  // Removed, then added again by name: same key, so the archive is back
  const rm = run(removeSectionPlan(state, 'phrasal-verbs', [], '2026-11-23').ops, {}, state).state;
  assert.equal(activeSections(rm).length, 3);
  const back = run(addSectionPlan(rm, 'Phrasal verbs').ops, {}, rm).state;
  assert.deepEqual(activeSections(back)[3], { key: 'phrasal-verbs', name: 'Phrasal verbs' });
});

test('rename an area: headings in every file, the target moves, the key stays; Undo restores all', () => {
  const f = files();
  const state = { targets: { Armenian: 3 } };
  const p = renameSectionPlan(state, 'armenian', 'Հայերեն', PATHS, Object.values(f));
  const r = run(p.ops, f, state);
  assert.deepEqual(names(r.files[CURRENT]), ['Հայերեն', 'General']);
  assert.deepEqual(names(r.files[PREPARED]), ['Հայերեն']);
  assert.deepEqual(names(r.files[WEEK]), ['English']);
  assert.equal(count(r.files), count(f));
  assert.deepEqual(r.state.targets, { Հայերեն: 3 });
  assert.equal(activeSections(r.state)[0].key, 'armenian');
  assert.ok(serializeDoc(r.files[CURRENT]).includes('## Հայերեն'));
  // the archive of the renamed area stays in its folder
  assert.equal(archiveOp(WEEK, 'Հայերեն', { id: 'a', meta: {}, body: 'x' }, '2026-11-23', 'armenian').to, 'archive/armenian/2026-11.md');
  // replaying the rename changes nothing (idempotent)
  for (const path of PATHS) assert.deepEqual(applyOp(p.ops[0], path, r.files[path]), r.files[path]);
  const u = run(p.undo, r.files, r.state);
  for (const path of PATHS) assert.equal(serializeDoc(u.files[path]), serializeDoc(f[path]));
  assert.deepEqual(u.state, { sections: null, targets: { Armenian: 3 } });
  // a default target goes with the area too
  const d = run(renameSectionPlan({}, 'armenian', 'Hay', PATHS, Object.values(f)).ops, f, {});
  assert.deepEqual(targetsOf(d.state), { Hay: 2, English: 2, General: 1 });
  // clashes
  assert.match(renameSectionPlan(state, 'armenian', 'english', PATHS, Object.values(f)).error, /already/);
  const stray = parseDoc('<!-- worddrill v1 -->\n\n## Idioms\n\n<!-- card id=z -->\nz\n');
  assert.match(renameSectionPlan(state, 'armenian', 'Idioms', PATHS, [stray]).error, /under the heading/);
});

test('rename into a heading that is already in a file merges the cards, none lost', () => {
  const d = parseDoc('<!-- worddrill v1 -->\n\n## Old\n\n<!-- card id=a -->\na\n\n## New\n\n<!-- card id=b -->\nb\n');
  const out = applyOp(renameOp([CURRENT], 'Old', 'New'), CURRENT, d);
  assert.deepEqual(names(out), ['New']);
  assert.deepEqual(allCards(out).map(c => c.id), ['b', 'a']);
});

test('remove an area: only when it has no cards in Today, Prepared or the weekly check', () => {
  const f = files();
  assert.match(removeSectionPlan({}, 'armenian', Object.values(f), '2026-11-23').error, /still has 3 cards/);
  assert.match(removeSectionPlan({}, 'english', Object.values(f), '2026-11-23').error, /still has 1 card /);
  const p = removeSectionPlan({}, 'general', [parseDoc('')], '2026-11-23');
  const s = run(p.ops, {}, {}).state;
  assert.deepEqual(activeSections(s).map(x => x.name), ['Armenian', 'English']);
  assert.deepEqual(sectionsList(s)[2], { key: 'general', name: 'General', removed: '2026-11-23' });
  assert.deepEqual(Object.keys(targetsOf(s)), ['Armenian', 'English']);
  const one = { sections: [{ key: 'x', name: 'X' }] };
  assert.match(removeSectionPlan(one, 'x', [], '2026-11-23').error, /At least one/);
});

test('reorder areas', () => {
  const s = run(moveSectionPlan({}, 'general', -1).ops, {}, {}).state;
  assert.deepEqual(activeSections(s).map(x => x.key), ['armenian', 'general', 'english']);
  assert.equal(moveSectionPlan({}, 'armenian', -1).ops, undefined);
});

test('split a card at the cursor: the second part goes right below with the same meta; Undo joins them back', () => {
  const f = files();
  const card = f[CURRENT].sections[0].cards[0];
  const body = 'first word\n\nsecond word';
  const p = splitPlan(CURRENT, 'Armenian', card, 0, body, body.indexOf('second'));
  const r = run(p.ops, { [CURRENT]: f[CURRENT] });
  const sec = r.files[CURRENT].sections[0];
  assert.deepEqual(sec.cards.map(c => c.body), ['first word', 'second word', 'beta']);
  assert.deepEqual(sec.cards[1].meta, { added: '2026-11-01' });
  assert.notEqual(sec.cards[1].id, card.id);
  // replay = no change
  const again = run(p.ops, r.files);
  assert.equal(serializeDoc(again.files[CURRENT]), serializeDoc(r.files[CURRENT]));
  const u = run(p.undo, r.files);
  assert.equal(serializeDoc(u.files[CURRENT]), serializeDoc(f[CURRENT]));
  // nothing to split at the very start or end
  assert.equal(splitPlan(CURRENT, 'Armenian', card, 0, body, 0), null);
  assert.equal(splitPlan(CURRENT, 'Armenian', card, 0, body + '\n\n', body.length), null);
  // Armenian text, cursor inside a word
  const hy = 'բարեւ աշխարհ';
  const s2 = splitPlan(CURRENT, 'Armenian', card, 0, hy, 5);
  assert.deepEqual([s2.ops[1].body, s2.card.body], ['բարեւ', 'աշխարհ']);
});

test('merge a card with the one below; Undo splits them back, interrupted merge keeps both texts', () => {
  const f = files();
  const [a, b] = f[CURRENT].sections[0].cards;
  const p = mergePlan(CURRENT, 'Armenian', a, b, 1);
  const r = run(p.ops, { [CURRENT]: f[CURRENT] });
  assert.deepEqual(r.files[CURRENT].sections[0].cards.map(c => [c.id, c.body]), [['a', 'alpha' + JOIN + 'beta']]);
  const half = run(p.ops.slice(0, 1), { [CURRENT]: f[CURRENT] });
  assert.ok(allCards(half.files[CURRENT]).some(c => c.body === 'beta'));
  const u = run(p.undo, r.files);
  assert.equal(serializeDoc(u.files[CURRENT]), serializeDoc(f[CURRENT]));
  // splitting at the join gives the two cards back
  const merged = r.files[CURRENT].sections[0].cards[0];
  const s = splitPlan(CURRENT, 'Armenian', merged, 0, merged.body, 'alpha'.length);
  assert.deepEqual([s.ops[1].body, s.card.body], ['alpha', 'beta']);
});

test('split parts: at --- lines or line by line; empty parts go, a ``` box is never cut', () => {
  const t = 'one\nline two\n\n---\n\nthree\n***\n\n---\nfour\n';
  assert.deepEqual(splitParts(t, 'marks'), ['one\nline two', 'three', 'four']);
  assert.deepEqual(splitParts(t, 'lines'), ['one', 'line two', 'three', 'four']);
  assert.deepEqual(splitParts('a\n  \n\tb\r\nc', 'lines'), ['a', '\tb', 'c']);
  // a box stays whole; in line by line it stays with the line above it
  const box = 'word\n```\nfrom a\n---\nroot\n```\nnext\n---\nlast';
  assert.deepEqual(splitParts(box, 'marks'), ['word\n```\nfrom a\n---\nroot\n```\nnext', 'last']);
  assert.deepEqual(splitParts(box, 'lines'), ['word\n```\nfrom a\n---\nroot\n```', 'next', 'last']);
  // nothing to split
  assert.deepEqual(splitParts('only\n---', 'marks'), ['only']);
  assert.deepEqual(splitParts('բարեւ\nпривет\nhello', 'lines'), ['բարեւ', 'привет', 'hello']);
  assert.deepEqual(splitParts('', 'lines'), []);
});

test('split a card into many: the parts go right below in order with the same meta; replay, Undo and an interrupted split keep every text', () => {
  const f = files();
  const card = f[CURRENT].sections[0].cards[0];
  const parts = splitParts('alpha\nnew one\nnew two', 'lines');
  const p = splitAllPlan(CURRENT, 'Armenian', card, 0, parts);
  const r = run(p.ops, { [CURRENT]: f[CURRENT] });
  const sec = r.files[CURRENT].sections[0];
  assert.deepEqual(sec.cards.map(c => c.body), ['alpha', 'new one', 'new two', 'beta']);
  assert.ok(sec.cards.slice(1, 3).every(c => c.meta.added === '2026-11-01' && c.id !== card.id));
  assert.equal(serializeDoc(run(p.ops, r.files).files[CURRENT]), serializeDoc(r.files[CURRENT]));
  assert.equal(serializeDoc(run(p.undo, r.files).files[CURRENT]), serializeDoc(f[CURRENT]));
  // stopped before the edit: the new cards are there and the old card still holds everything
  for (let k = 1; k < p.ops.length; k++) {
    const half = run(p.ops.slice(0, k), { [CURRENT]: f[CURRENT] });
    assert.ok(allCards(half.files[CURRENT]).some(c => c.id === 'a' && c.body === 'alpha'));
    assert.equal(allCards(half.files[CURRENT]).length, 3 + k);
  }
  assert.equal(splitAllPlan(CURRENT, 'Armenian', card, 0, ['one']), null);
  // merged cards split at their --- lines come back apart
  const [a, b] = f[CURRENT].sections[0].cards;
  const m = run(mergePlan(CURRENT, 'Armenian', a, b, 1).ops, { [CURRENT]: f[CURRENT] }).files[CURRENT].sections[0].cards[0];
  assert.deepEqual(splitParts(m.body, 'marks'), ['alpha', 'beta']);
});

test('coverage: the days Preparation lasts (P / T); the shortest over the areas', () => {
  assert.deepEqual(coverage(5, 2), { days: 2.5 });
  assert.deepEqual(coverage(0, 2), { days: 0 });
  assert.equal(coverage(3, 0), null);
  assert.equal(coverage(3, undefined), null);
  assert.deepEqual(coverage(1, 3), { days: 0.3 });
  assert.equal(coverageText(coverage(5, 2)), '(2.5 days)');
  assert.equal(coverageText(coverage(2, 2)), '(1 day)');
  assert.equal(coverageText(coverage(0, 1)), '(0 days)');
  // Armenian 12 at 2 = 6 days, English 2 at 2 = 1 day → 1 (English); an area without a target doesn't count
  const prep = parseDoc('<!-- worddrill v1 -->\n\n## Armenian\n\n' + Array.from({ length: 12 }, (_, i) => '<!-- card id=a' + i + ' -->\nx\n').join('\n') + '\n## English\n\n<!-- card id=e1 -->\ny\n\n<!-- card id=e2 -->\nz\n');
  assert.deepEqual(minCoverage(prep, { Armenian: 2, English: 2, Extra: 0 }), { days: 1, section: 'English' });
  assert.deepEqual(minCoverage(prep, { Armenian: 2, General: 1 }), { days: 0, section: 'General' });
  assert.equal(minCoverage(prep, {}), null);
});
