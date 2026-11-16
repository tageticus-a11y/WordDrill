import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, plainText, toggleWrap, toggleLinePrefix, toggleFence, firstLine, insertTable } from '../js/markdown.js';

test('inline bold, italic, escapes', () => {
  assert.deepEqual(parseInline('a **b** *c* _d_ \\*e\\*'), [
    { t: 'text', v: 'a ' }, { t: 'b', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' ' },
    { t: 'i', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' }, { t: 'i', c: [{ t: 'text', v: 'd' }] },
    { t: 'text', v: ' *e*' }
  ]);
  assert.deepEqual(parseInline('snake_case_word'), [{ t: 'text', v: 'snake_case_word' }]);
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }]);
  assert.deepEqual(parseInline('**ամուր**'), [{ t: 'b', c: [{ t: 'text', v: 'ամուր' }] }]);
});

test('blocks: paragraphs with line breaks, quotes, lists', () => {
  const b = parseBlocks('“strong”\n**ամուր**\n\n> one\n> two\n\n- x\n- y\n1. n');
  assert.deepEqual(b.map(x => x.t), ['p', 'quote', 'ul', 'ol']);
  assert.equal(b[0].lines.length, 2);
  assert.equal(b[1].blocks[0].lines.length, 2);
  assert.equal(b[2].items.length, 2);
});

test('numbered items separated by quotes keep their numbers', () => {
  const b = parseBlocks('1) first\n> example one\n2) second\n> example two\n3. third');
  assert.deepEqual(b.map(x => x.t), ['ol', 'quote', 'ol', 'quote', 'ol']);
  assert.deepEqual(b.filter(x => x.t === 'ol').map(x => x.start), [1, 2, 3]);
  assert.equal(parseBlocks('5. a\n6. b')[0].start, 5);
});

test('underline between tildes, inline code', () => {
  assert.deepEqual(parseInline('~прил.~ and ~~noun~~'), [
    { t: 'u', c: [{ t: 'text', v: 'прил.' }] }, { t: 'text', v: ' and ' }, { t: 'u', c: [{ t: 'text', v: 'noun' }] }
  ]);
  assert.deepEqual(parseInline('about ~ 5 ~ words'), [{ t: 'text', v: 'about ~ 5 ~ words' }]);
  assert.deepEqual(parseInline('`*raw* ~x~`'), [{ t: 'code', v: '*raw* ~x~' }]);
});

test('``` box keeps its lines as they are', () => {
  const b = parseBlocks('word\n```\nfrom Latin *raucus*\n## not a heading\n```\n> example');
  assert.deepEqual(b.map(x => x.t), ['p', 'code', 'quote']);
  assert.equal(b[1].text, 'from Latin *raucus*\n## not a heading');
  assert.equal(parseBlocks('```\nunclosed')[0].text, 'unclosed');
  assert.equal(plainText('```\nLat. raucus\n```'), 'Lat. raucus');
});

test('toggleFence wraps lines in a box and unwraps them', () => {
  const v = 'word\nfrom Latin\nexample';
  const r = toggleFence(v, 6, 9);
  assert.equal(r.value, 'word\n```\nfrom Latin\n```\nexample');
  assert.equal(r.value.slice(r.start, r.end), 'from Latin');
  assert.equal(toggleFence(r.value, r.start, r.end).value, v);
  assert.equal(toggleFence('', 0, 0).value, '```\n\n```');
});

test('first line for collapsed cards', () => {
  assert.equal(firstLine('\n  raucous (խռպոտ)\n[ˈrɔːkəs]'), 'raucous (խռպոտ)');
  assert.equal(firstLine(''), '');
  // A table shows only its first cell
  assert.equal(firstLine('| գնալ | to go |\n| --- | --- |\n| գնում եմ | I go |'), 'գնալ');
});

test('tables: header, alignment, rows, escaped pipes', () => {
  const b = parseBlocks('verb\n| A | B | C |\n|:--|:-:|--:|\n| **x** | y \\| z |\n| 1 | 2 | 3 | 4 |\n\nafter');
  assert.deepEqual(b.map(x => x.t), ['p', 'table', 'p']);
  const t = b[1];
  assert.deepEqual(t.align, ['left', 'center', 'right']);
  assert.deepEqual(t.head, [[{ t: 'text', v: 'A' }], [{ t: 'text', v: 'B' }], [{ t: 'text', v: 'C' }]]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], [[{ t: 'b', c: [{ t: 'text', v: 'x' }] }], [{ t: 'text', v: 'y | z' }], []]);   // short row padded
  assert.equal(t.rows[1].length, 3);                                                                       // long row cut
  assert.equal(plainText('| a | b |\n|---|---|\n| c | d |'), 'a | b\nc | d');
  // Rows end at a blank line; tables work inside quotes
  assert.deepEqual(parseBlocks('> | a |\n> |---|\n> | b |')[0].blocks.map(x => x.t), ['table']);
});

test('pipes without a delimiter row stay text', () => {
  assert.deepEqual(parseBlocks('a | b\nc | d').map(x => x.t), ['p']);
  assert.deepEqual(parseBlocks('| a | b |\n| --- |').map(x => x.t), ['p']);   // cell counts differ
  assert.deepEqual(parseBlocks('1) one | two\n2) three').map(x => x.t), ['ol']);
});

test('insertTable adds an empty table on the next line', () => {
  const r = insertTable('word\nexample', 2, 2);
  assert.equal(r.value, 'word\n\n| Word | Meaning |\n| --- | --- |\n|  |  |\n|  |  |\n\nexample');
  assert.equal(r.value.slice(r.start, r.end), 'Word');
  assert.equal(insertTable('', 0, 0).value, '| Word | Meaning |\n| --- | --- |\n|  |  |\n|  |  |');
  assert.equal(parseBlocks(r.value)[1].t, 'table');
});

test('plain text for search', () => {
  assert.equal(plainText('**ամուր**\n> *very* sturdy'), 'ամուր\nvery sturdy');
});

test('toggleWrap wraps, unwraps, and inserts', () => {
  assert.deepEqual(toggleWrap('a word b', 2, 6, '**'), { value: 'a **word** b', start: 4, end: 8 });
  assert.deepEqual(toggleWrap('a **word** b', 4, 8, '**'), { value: 'a word b', start: 2, end: 6 });
  assert.deepEqual(toggleWrap('a **word** b', 2, 10, '**'), { value: 'a word b', start: 2, end: 6 });
  assert.deepEqual(toggleWrap('ab', 1, 1, '*'), { value: 'a**b', start: 2, end: 2 });
  assert.deepEqual(toggleWrap('a word b', 1, 7, '*'), { value: 'a *word* b', start: 3, end: 7 });
  // italic inside bold wraps rather than stripping the bold marks
  assert.equal(toggleWrap('**word**', 2, 6, '*').value, '***word***');
});

test('toggleLinePrefix adds and removes on all selected lines', () => {
  const v = 'one\ntwo\n\nthree';
  const r = toggleLinePrefix(v, 1, 6, '> ');
  assert.equal(r.value, '> one\n> two\n\nthree');
  assert.equal(toggleLinePrefix(r.value, r.start, r.end, '> ').value, v);
  assert.equal(toggleLinePrefix('a\nb', 0, 3, '1. ').value, '1. a\n2. b');
  assert.equal(toggleLinePrefix('1. a\n2. b', 0, 9, '1. ').value, 'a\nb');
  assert.equal(toggleLinePrefix('', 0, 0, '- ').value, '- ');
});
