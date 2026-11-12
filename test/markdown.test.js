import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, plainText, toggleWrap, toggleLinePrefix } from '../js/markdown.js';

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
