import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHECK_PROMPT, promptOf, recallFor, typedTexts, buildCheckText, copyShortcutOf } from '../js/recall.js';

test('typed cards are kept for the same date only', () => {
  const saved = { date: '2026-11-16', items: [{ id: 'a', text: 'tun' }] };
  assert.equal(recallFor(saved, '2026-11-16'), saved);
  assert.deepEqual(recallFor(saved, '2026-11-17'), { date: '2026-11-17', items: [] });
  assert.deepEqual(recallFor(null, '2026-11-17'), { date: '2026-11-17', items: [] });
  assert.deepEqual(typedTexts({ items: [{ text: '  a ' }, { text: '' }, { text: '\n' }, {}] }), ['a']);
});

test('prompt from settings, default when empty', () => {
  assert.equal(promptOf({}), DEFAULT_CHECK_PROMPT);
  assert.equal(promptOf({ aiPrompt: '  ' }), DEFAULT_CHECK_PROMPT);
  assert.equal(promptOf({ aiPrompt: null }), DEFAULT_CHECK_PROMPT);
  assert.equal(promptOf({ aiPrompt: 'Check {typed}' }), 'Check {typed}');
});

test('check text puts both lists into the prompt', () => {
  const sections = [
    { name: 'Armenian', cards: [{ body: '“house”\n**տուն**' }] },
    { name: 'English', cards: [] },
    { name: 'General', cards: [{ body: 'one' }, { body: 'two {cards}' }] }
  ];
  const t = buildCheckText('Typed:\n{typed}\nCards:\n{cards}', ['տուն', 'too\nsecond line'], sections);
  assert.equal(t, 'Typed:\n1. տուն\n2. too\n   second line\nCards:\nArmenian:\n1. “house”\n   տուն\n\nGeneral:\n1. one\n2. two {cards}\n');
});

test('check text without placeholders adds the lists at the end', () => {
  const t = buildCheckText('Check my spelling.', [], [{ name: 'English', cards: [{ body: '~adj.~ raucous' }] }]);
  assert.equal(t, 'Check my spelling.\n\nWhat I typed:\n(nothing typed)\n\nThe cards:\nEnglish:\n1. adj. raucous\n');
  assert.ok(buildCheckText(DEFAULT_CHECK_PROMPT, ['x'], []).includes('(no cards)'));
});

test('Copy for AI check shortcut: Ctrl+Shift+1 unless changed or turned off', () => {
  assert.equal(copyShortcutOf({}), 'Ctrl+Shift+Digit1');
  assert.equal(copyShortcutOf(null), 'Ctrl+Shift+Digit1');
  assert.equal(copyShortcutOf({ aiShortcut: 'Alt+KeyC' }), 'Alt+KeyC');
  assert.equal(copyShortcutOf({ aiShortcut: '' }), '');
  assert.equal(copyShortcutOf({ aiShortcut: null }), 'Ctrl+Shift+Digit1');
});
