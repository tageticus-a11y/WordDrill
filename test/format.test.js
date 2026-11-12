import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseDoc, serializeDoc, parseState, serializeState, allCards, escapeLine, unescapeLine } from '../js/format.js';

const FIX = new URL('./fixtures/', import.meta.url);

// Golden files: every format version ever written must keep parsing without losing anything.
// Never edit or delete these; add new ones when the format changes.
for (const ver of readdirSync(FIX)) {
  const dir = new URL(ver + '/', FIX);
  const expected = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8'));
  for (const [name, exp] of Object.entries(expected)) {
    test(`golden ${ver}/${name}: all cards survive`, () => {
      const text = readFileSync(new URL(name, dir), 'utf8');
      const doc = parseDoc(text);
      assert.deepEqual(allCards(doc).map(c => c.id), exp.ids);
      assert.equal(allCards(doc).length, exp.cards);
      assert.deepEqual(doc.sections.map(s => s.name), exp.sections);
      // Every non-structural line of the file is somewhere in a card body
      const bodies = allCards(doc).map(c => c.body).join('\n');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || /^<!-- (card|worddrill)/.test(line) || /^## /.test(line)) continue;
        assert.ok(bodies.includes(unescapeLine(line)), 'lost line: ' + line);
      }
    });
    test(`golden ${ver}/${name}: canonical round trip`, () => {
      const text = readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(serializeDoc(parseDoc(text)), text);
    });
  }
}

test('golden v1/current.md: content details', () => {
  const doc = parseDoc(readFileSync(new URL('v1/current.md', FIX), 'utf8'));
  const [a, , e, g] = allCards(doc);
  assert.equal(a.meta.added, '2026-11-10');
  assert.match(a.body, /^“strong; sturdy; firm.”\n\n\*\*ամուր\*\*\n\n> Այս/);
  assert.equal(e.meta.note, 'two words');
  assert.equal(g.body.split('\n')[1], '## Not a section');
  assert.equal(g.body.split('\n')[2], '<!-- card id=fake -->');
  assert.equal(g.body.split('\n')[3], '\\## Already escaped once');
});

test('model round trip with tricky bodies', () => {
  const doc = { version: 1, sections: [
    { name: 'Armenian', cards: [
      { id: 'x1', meta: { added: '2026-01-01' }, body: '## heading-like\n<!-- card id=evil -->\n<!-- worddrill v9 -->' },
      { id: 'x2', meta: {}, body: 'line one\n\n\nline after blank lines\n---\n> quote' },
      { id: 'x3', meta: { moved: '2026-02-02', odd: 'a b=c-->' }, body: '' }
    ] },
    { name: 'English', cards: [] },
    { name: 'General', cards: [{ id: 'x4', meta: {}, body: '\\\\## two backslashes\nВсё ок ‘quotes’ “and” «ёлки»' }] }
  ] };
  const text = serializeDoc(doc);
  assert.deepEqual(parseDoc(text), doc);
  assert.equal(serializeDoc(parseDoc(text)), text);
});

test('escape is reversible', () => {
  for (const l of ['## a', '##', '\\## a', '\\\\## a', '<!-- card x -->', '\\<!-- worddrill v1 -->', '### not escaped', '#tag', 'plain'])
    assert.equal(unescapeLine(escapeLine(l)), l);
  assert.equal(escapeLine('### h3'), '### h3');
});

test('hand-written text outside cards is kept', () => {
  const doc = parseDoc('some note before any heading\n\n## Armenian\nloose word\n\nmore loose\n<!-- card id=k -->\nreal card\n## Fresh\ntext');
  const cards = allCards(doc);
  assert.equal(cards.length, 4);
  assert.equal(cards[0].body, 'some note before any heading');
  assert.equal(cards[1].body, 'loose word\n\nmore loose');
  assert.equal(cards[2].id, 'k');
  assert.equal(cards[3].body, 'text');
  // Ids for cards without one are stable between parses
  assert.equal(parseDoc(serializeDoc(doc)).sections[1].cards[0].id, cards[1].id);
  const again = parseDoc(serializeDoc(doc));
  assert.deepEqual(allCards(again).map(c => c.body), cards.map(c => c.body));
});

test('duplicate ids in a file do not merge cards', () => {
  const doc = parseDoc('## A\n<!-- card id=same -->\none\n<!-- card id=same -->\ntwo');
  const ids = allCards(doc).map(c => c.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('CRLF, BOM, missing header and empty input', () => {
  const doc = parseDoc('﻿## English\r\n<!-- card id=a -->\r\nword\r\n');
  assert.equal(doc.version, null);
  assert.equal(allCards(doc)[0].body, 'word');
  assert.deepEqual(parseDoc('').sections, []);
  assert.deepEqual(parseDoc(null).sections, []);
  assert.equal(serializeDoc({ sections: [] }), '<!-- worddrill v1 -->\n');
});

test('state.json', () => {
  assert.deepEqual(parseState(''), {});
  assert.deepEqual(parseState('garbage'), {});
  assert.deepEqual(parseState('[1]'), {});
  const s = { weekCheckDone: '2026-11-12' };
  assert.deepEqual(parseState(serializeState(s)), s);
});
