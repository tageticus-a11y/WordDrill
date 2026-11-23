import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, plainText, firstLine, insertRule, toggleLinePrefix } from '../js/markdown.js';
import { parseDoc, serializeDoc, allCards } from '../js/format.js';
import { mergePlan, splitPlan, CURRENT } from '../js/ops.js';

const kinds = md => parseBlocks(md).map(b => b.t === 'h' ? 'h' + b.level : b.t);

test('headings # … ###### and horizontal lines', () => {
  assert.deepEqual(kinds('# Title\n## Sub\n###### Six\n####### seven'), ['h1', 'h2', 'h6', 'p']);
  assert.deepEqual(parseBlocks('## **ամուր** ##')[0], { t: 'h', level: 2, c: [{ t: 'b', c: [{ t: 'text', v: 'ամուր' }] }] });
  assert.deepEqual(kinds('#hashtag\n#'), ['p']);                       // no space: plain text
  assert.deepEqual(kinds('word\n---\nnext'), ['p', 'hr', 'p']);         // a line, not a heading underline
  assert.deepEqual(kinds('***\n___\n- - -\n--'), ['hr', 'hr', 'hr', 'p']);
  assert.deepEqual(kinds('- item\n---'), ['ul', 'hr']);
  assert.deepEqual(kinds('| a | b |\n| --- | --- |\n| c | d |'), ['table']);
  assert.equal(plainText('# Title\n\n---\n\nбыть'), 'Title\nбыть');
});

test('collapsed cards skip a leading line; a heading shows as the first line', () => {
  assert.equal(firstLine('---\n\nword\nmeaning'), 'word');
  assert.equal(firstLine('## word\nmeaning'), '## word');
});

test('insertRule puts --- on its own line after the cursor', () => {
  const r = insertRule('word\nexample', 2, 2);
  assert.equal(r.value, 'word\n\n---\n\nexample');
  assert.equal(r.value.slice(r.start), 'example');
  assert.equal(insertRule('', 0, 0).value, '---');
  assert.equal(insertRule('word', 4, 4).value, 'word\n\n---');
  assert.equal(toggleLinePrefix('word', 0, 4, '## ').value, '## word');
  assert.equal(toggleLinePrefix('## word', 0, 7, '## ').value, 'word');
});

test('headings and lines in a card survive the file format', () => {
  const body = '# Title\n## Sub ##\n\n---\n\n### x\n***';
  const text = serializeDoc({ version: 1, sections: [{ name: 'General', cards: [{ id: 'a', meta: {}, body }] }] });
  const back = parseDoc(text);
  assert.equal(back.sections.length, 1);
  assert.deepEqual(allCards(back).map(c => c.body), [body]);
});

test('merged cards are joined with a line; splitting there gives both cards back', () => {
  const doc = parseDoc('<!-- worddrill v1 -->\n\n## General\n\n<!-- card id=a -->\nalpha\n\n<!-- card id=b -->\nbeta\n');
  const [a, b] = allCards(doc);
  const merged = mergePlan(CURRENT, 'General', a, b, 1).ops[0].body;
  assert.equal(merged, 'alpha\n\n---\n\nbeta');
  for (const pos of [5, merged.indexOf('---'), merged.indexOf('beta')]) {
    const p = splitPlan(CURRENT, 'General', { ...a, body: merged }, 0, merged, pos);
    assert.deepEqual([p.ops[1].body, p.card.body], ['alpha', 'beta'], 'split at ' + pos);
  }
  // a card that is only a line is not split off
  assert.equal(splitPlan(CURRENT, 'General', a, 0, 'alpha\n---', 5), null);
});
