import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueSettings, queuePath, isQueueFile, queueFiles, nextQueuePath, appendTarget, soonTarget, filesForSoon, splitBlocks, chunk } from '../js/queue.js';
import { parseDoc, serializeDoc, allCards, hashId } from '../js/format.js';
import { applyOp, opTargets, PREPARED, queueAddOp, queueToPreparedPlan, queueToEndPlan, forgotPlan, removeSectionPlan } from '../js/ops.js';

const P = n => queuePath('english', n);
const files = (...counts) => counts.map((count, i) => ({ path: P(i + 1), count }));
const apply = (ops, docs) => {
  for (const op of [].concat(ops)) for (const p of opTargets(op)) docs[p] = applyOp(op, p, docs[p] || parseDoc(''));
  return docs;
};
const qDoc = (...ids) => parseDoc('<!-- worddrill v1 -->\n\n' + ids.map(id => '<!-- card id=' + id + ' -->\nnote ' + id + '\n').join('\n'));
const idsOf = doc => allCards(doc).map(c => c.id);

test('queue paths and settings', () => {
  assert.equal(P(1), 'queue/english/0001.md');
  assert.ok(isQueueFile('queue/english/0031.md'));
  assert.ok(!isQueueFile('queue/english/notes.md') && !isQueueFile('archive/english/2026-11.md') && !isQueueFile('current.md'));
  assert.deepEqual(queueFiles(['queue/english/0010.md', 'queue/general/0001.md', 'queue/english/0002.md', 'current.md'], 'english'),
    ['queue/english/0002.md', 'queue/english/0010.md']);
  assert.equal(nextQueuePath([], 'english'), P(1));
  assert.equal(nextQueuePath(['queue/english/0003.md', 'queue/english/0007.md'], 'english'), P(8));
  assert.deepEqual(queueSettings({}), { fileSize: 50, soonAfter: 50 });
  assert.deepEqual(queueSettings({ queue: { fileSize: 30, soonAfter: 2 } }), { fileSize: 30, soonAfter: 5 });
  assert.deepEqual(queueSettings({ queue: { fileSize: 'x' } }), { fileSize: 50, soonAfter: 50 });
});

test('the end of the queue: the last file until it is full, then a new one; gaps in numbers are fine', () => {
  assert.deepEqual(appendTarget([], 'english'), { path: P(1), index: 0 });
  assert.deepEqual(appendTarget(files(50, 7), 'english'), { path: P(2), index: 7 });
  assert.deepEqual(appendTarget(files(50, 50), 'english'), { path: P(3), index: 0 });
  assert.deepEqual(appendTarget([{ path: P(5), count: 50 }], 'english'), { path: P(6), index: 0 });
  assert.deepEqual(appendTarget(files(50, 20), 'english', { fileSize: 20, soonAfter: 50 }), { path: P(3), index: 0 });
});

test('soon: after the first soonAfter cards counted across files; a shorter queue appends', () => {
  assert.deepEqual(soonTarget(files(50, 50, 7), 'english'), { path: P(1), index: 50 });
  assert.deepEqual(soonTarget(files(30, 50), 'english'), { path: P(2), index: 20 });   // spills into the second file
  assert.deepEqual(soonTarget(files(62, 50), 'english'), { path: P(1), index: 50 });   // a file over the size is fine
  assert.deepEqual(soonTarget(files(10, 12), 'english'), { path: P(2), index: 12 });   // short queue: the end
  assert.deepEqual(soonTarget(files(50), 'english', { fileSize: 50, soonAfter: 60 }), { path: P(2), index: 0 });   // short and full: a new file at the end
  assert.deepEqual(soonTarget([], 'english'), { path: P(1), index: 0 });
  assert.deepEqual(soonTarget(files(30, 50), 'english', { fileSize: 50, soonAfter: 10 }), { path: P(1), index: 10 });
  assert.equal(filesForSoon([30, 50, 50], 50), 2);
  assert.equal(filesForSoon([60, 50], 50), 1);
  assert.equal(filesForSoon([], 50), 0);
});

test('notes split into blocks at empty or blank lines; nothing else changes', () => {
  const text = '﻿one\r\nline two\r\n\r\n\r\n  \t\r\n> quote\r\n  indented\r\n\r\nlast';
  assert.deepEqual(splitBlocks(text), ['one\nline two', '> quote\n  indented', 'last']);
  assert.deepEqual(splitBlocks(''), []);
  assert.deepEqual(splitBlocks('\n\n'), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('import round trip: blocks with structure-like lines come back exactly, in order', () => {
  const blocks = splitBlocks(['alpha', '', '## not a heading\ntext', '', '<!-- card id=x -->\nbody', '', '<!-- worddrill v1 -->', '', '##', '', '\\## escaped', '', '1\nfoo\n2\nbar'].join('\n'));
  assert.equal(blocks.length, 7);
  const out = chunk(blocks, 3).map((part, f) => serializeDoc({ version: 1, sections: [{ name: '', cards: part.map((body, i) => ({ id: hashId('english\n' + (f * 3 + i) + '\n' + body), meta: { added: '2026-11-24' }, body })) }] }));
  assert.equal(out.length, 3);
  assert.ok(out.every(t => !/^## /m.test(t.replace(/^\\## .*$/gm, ''))));   // no headings: all in section ''
  const back = out.flatMap(t => parseDoc(t).sections.flatMap(s => { assert.equal(s.name, ''); return s.cards.map(c => c.body); }));
  assert.deepEqual(back, blocks);
});

test('queue plans: add soon / end, to Preparation (bottom), to the end, with Undo', () => {
  let docs = { [P(1)]: qDoc('a', 'b', 'c'), [P(2)]: qDoc('d'), [PREPARED]: parseDoc('## English\n<!-- card id=p -->\nprep\n') };
  const add = queueAddOp({ path: P(1), index: 2 }, 'new words', '2026-11-24');
  docs = apply(add, docs);
  assert.deepEqual(idsOf(docs[P(1)]), ['a', 'b', add.card.id, 'c']);
  assert.equal(docs[P(1)].sections[0].name, '');

  const b = allCards(docs[P(1)])[1];
  const toPrep = queueToPreparedPlan(P(1), 'English', b, 1);
  let after = apply(toPrep.ops, { ...docs });
  assert.deepEqual(idsOf(after[PREPARED]), ['p', 'b']);   // the end of the line
  assert.deepEqual(idsOf(after[P(1)]), ['a', add.card.id, 'c']);
  assert.deepEqual(apply(toPrep.ops, { ...after }), after);   // idempotent
  after = apply(toPrep.undo, after);
  assert.deepEqual(idsOf(after[P(1)]), idsOf(docs[P(1)]));
  assert.deepEqual(idsOf(after[PREPARED]), ['p']);

  // to the end: another file …
  const a = allCards(docs[P(1)])[0];
  const toEnd = queueToEndPlan(docs[P(1)], P(1), a, 0, { path: P(2), index: 1 });
  after = apply(toEnd.ops, { ...docs });
  assert.deepEqual(idsOf(after[P(2)]), ['d', 'a']);
  assert.ok(!idsOf(after[P(1)]).includes('a'));
  assert.deepEqual(idsOf(apply(toEnd.undo, after)[P(1)]), idsOf(docs[P(1)]));
  // … or the same file (it is the last one)
  const d = allCards(docs[P(2)])[0];
  const two = apply(queueAddOp({ path: P(2), index: 1 }, 'e', '2026-11-24'), { ...docs });
  const same = queueToEndPlan(two[P(2)], P(2), d, 0, { path: P(2), index: 2 });
  assert.equal(idsOf(apply(same.ops, { ...two })[P(2)]).at(-1), 'd');
  assert.deepEqual(idsOf(apply(same.undo, apply(same.ops, { ...two }))[P(2)]), idsOf(two[P(2)]));
});

test('Forgot: weekday file → queue at the soon place, moved date dropped; interrupted keeps the card; Undo', () => {
  const WEEK = 'week/4-thu.md';
  let docs = { [WEEK]: parseDoc('## English\n<!-- card id=w added=2026-10-01 moved=2026-11-05 -->\nforgotten\n'), [P(1)]: qDoc('a', 'b') };
  const card = allCards(docs[WEEK])[0];
  const plan = forgotPlan(WEEK, 'English', card, 0, { path: P(1), index: 1 }, '2026-11-12');
  const [op] = plan.ops;
  assert.deepEqual(opTargets(op), [P(1), WEEK]);   // the queue first
  const half = { ...docs, [P(1)]: applyOp(op, P(1), docs[P(1)]) };   // interrupted after the first file
  assert.equal(allCards(half[WEEK]).length + allCards(half[P(1)]).length, 4);
  const after = apply(plan.ops, { ...docs });
  assert.deepEqual(idsOf(after[P(1)]), ['a', 'w', 'b']);
  assert.deepEqual(allCards(after[P(1)])[1].meta, { added: '2026-10-01', forgot: '2026-11-12' });
  assert.deepEqual(idsOf(after[WEEK]), []);
  const back = apply(plan.undo, after);
  assert.deepEqual(allCards(back[WEEK])[0], card);
  assert.deepEqual(idsOf(back[P(1)]), ['a', 'b']);
});

test('an area with cards in its queue cannot be removed', () => {
  const r = removeSectionPlan({}, 'english', [], '2026-11-24', 2);
  assert.match(r.error, /queue/);
  assert.ok(removeSectionPlan({}, 'english', [], '2026-11-24', 0).ops);
});
