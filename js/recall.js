// Recall practice (pure): the cards typed from memory before Today's list is shown, the text copied for an AI
// spelling check, and what is typed under each collapsed Weekly check card. All typing stays in this browser
// only (localStorage), never in Dropbox.

import { plainText } from './markdown.js';

export const DEFAULT_CHECK_PROMPT = `I'm memorizing words and phrases (Armenian, English, Russian). Below are two lists: what I typed from memory, and the real cards.

Match each typed entry to its card yourself: the order may differ, and some cards may be missing because I couldn't recall them.
For each typed entry, say whether it is right. If not, write the correct version and put the wrong or missing letters in **bold**.
Then list the cards I didn't recall at all.
Ignore formatting, punctuation and letter case unless they change the meaning. Keep the answer short.

What I typed:
{typed}

The cards:
{cards}`;

/** The prompt from state.json (Settings), or the default one */
export const promptOf = state => (state && typeof state.aiPrompt === 'string' && state.aiPrompt.trim()) ? state.aiPrompt : DEFAULT_CHECK_PROMPT;

/** Shortcut for Copy for AI check (state.json aiShortcut; '' = none), in the format of shortcutOf (js/timer.js) */
export const DEFAULT_COPY_SHORTCUT = 'Ctrl+Shift+Digit1';
export const copyShortcutOf = state => (state && typeof state.aiShortcut === 'string' ? state.aiShortcut : DEFAULT_COPY_SHORTCUT);

/** Today's typed cards: the saved ones if they are from this date, otherwise a fresh empty list */
export function recallFor(saved, date) {
  if (saved && saved.date === date && Array.isArray(saved.items)) return saved;
  return { date, items: [] };
}

/** Weekly check: text typed per card id ({ date, byId }), kept for this date only */
export function checkTypedFor(saved, date) {
  if (saved && saved.date === date && saved.byId && typeof saved.byId === 'object') return saved;
  return { date, byId: {} };
}

/** Typed entries that have text */
export const typedTexts = recall => recall.items.map(i => String(i.text || '').trim()).filter(Boolean);

// "1. first line" with the following lines indented under it
const numbered = texts => texts.map((t, i) => {
  const lines = t.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  const pad = ' '.repeat(String(i + 1).length + 2);
  return (i + 1) + '. ' + lines.map((l, j) => (j ? pad : '') + l).join('\n');
}).join('\n');

/**
 * The text for the AI check. sections: [{ name, cards: [{ body }] }].
 * {typed} and {cards} in the prompt mark where the lists go; without them the lists are added at the end.
 */
export function buildCheckText(prompt, typed, sections) {
  const typedText = typed.length ? numbered(typed) : '(nothing typed)';
  const cardsText = sections.filter(s => s.cards.length)
    .map(s => (s.name ? s.name + ':\n' : '') + numbered(s.cards.map(c => plainText(c.body))))
    .join('\n\n') || '(no cards)';
  let p = String(prompt || '');
  const hasTyped = p.includes('{typed}'), hasCards = p.includes('{cards}');
  p = p.replace(/\{typed\}|\{cards\}/g, m => (m === '{typed}' ? typedText : cardsText));   // one pass: card text may contain "{cards}"
  if (!hasTyped) p += '\n\nWhat I typed:\n' + typedText;
  if (!hasCards) p += '\n\nThe cards:\n' + cardsText;
  return p.trim() + '\n';
}
