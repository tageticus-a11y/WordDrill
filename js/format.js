// File format: Markdown files of cards grouped by "## Section" headings.
// Pure module: used by the app and by the Node tests. See CLAUDE.md "File format" — it must stay
// backward compatible: every file any release ever wrote must still parse without losing text.

export const FORMAT_VERSION = 1;
export const FORMAT_HEADER = '<!-- worddrill v1 -->';

const HEADER_RE = /^<!--[ \t]*worddrill[ \t]+v(\d+)[ \t]*-->[ \t]*$/;
const SECTION_RE = /^##(?:[ \t]+(.*?))?[ \t]*$/;
const CARD_RE = /^<!--[ \t]*card\b(.*?)-->[ \t]*$/;
// Body lines that would be read as structure are saved with one extra leading backslash
const ESCAPED_RE = /^\\+(?:##(?:[ \t]|$)|<!--[ \t]*(?:card|worddrill)\b)/;
const NEEDS_ESCAPE_RE = /^\\*(?:##(?:[ \t]|$)|<!--[ \t]*(?:card|worddrill)\b)/;

export const escapeLine = l => (NEEDS_ESCAPE_RE.test(l) ? '\\' + l : l);
export const unescapeLine = l => (ESCAPED_RE.test(l) ? l.slice(1) : l);

// Short deterministic hash (FNV-1a) — ids for cards that have none, e.g. text typed by hand in Dropbox
export function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'h' + (h >>> 0).toString(36);
}

function parseMeta(s) {
  const meta = {};
  for (const part of s.trim().split(/\s+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    let v = eq < 0 ? '' : part.slice(eq + 1);
    try { v = decodeURIComponent(v); } catch (e) { /* keep as is */ }
    meta[k] = v;
  }
  return meta;
}
const metaStr = (id, meta) => ['id=' + encodeURIComponent(id)]
  .concat(Object.keys(meta).filter(k => k !== 'id' && /^[\w.-]+$/.test(k)).map(k => k + '=' + encodeURIComponent(meta[k])))
  .join(' ');

const trimBlankLines = lines => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};
export const normalizeBody = s => trimBlankLines(String(s).replace(/\r\n?/g, '\n').split('\n')).join('\n');

/** text → { version, sections: [{ name, cards: [{ id, meta, body }] }] }. Never drops text. */
export function parseDoc(text) {
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const doc = { version: null, sections: [] };
  let i = 0;
  const h = lines.length && lines[0].match(HEADER_RE);
  if (h) { doc.version = +h[1]; i = 1; }
  let section = null, card = null;
  const usedIds = new Set();
  const finish = () => {
    if (!card) return;
    const body = trimBlankLines(card.lines).map(unescapeLine).join('\n');
    let id = card.meta.id;
    // Missing or duplicate id: derive one from the content, so nothing is lost or merged by mistake
    if (!id || usedIds.has(id)) id = hashId(section.name + '\n' + section.cards.length + '\n' + body);
    while (usedIds.has(id)) id += 'x';
    usedIds.add(id);
    const meta = { ...card.meta }; delete meta.id;
    section.cards.push({ id, meta, body });
    card = null;
  };
  const ensureSection = () => { if (!section) { section = { name: '', cards: [] }; doc.sections.push(section); } };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const s = line.match(SECTION_RE);
    if (s) { finish(); section = { name: (s[1] || '').trim(), cards: [] }; doc.sections.push(section); continue; }
    const c = line.match(CARD_RE);
    if (c) { finish(); ensureSection(); card = { meta: parseMeta(c[1]), lines: [] }; continue; }
    if (card) { card.lines.push(line); continue; }
    if (!line.trim()) continue;
    // Text outside any card (typed by hand): keep it as a card of its own
    ensureSection();
    card = { meta: {}, lines: [line] };
  }
  finish();
  return doc;
}

/** doc → canonical text. parseDoc(serializeDoc(d)) deep-equals d for docs with normalized bodies. */
export function serializeDoc(doc) {
  const out = [FORMAT_HEADER, ''];
  doc.sections.forEach((sec, idx) => {
    if (sec.name !== '' || idx > 0) out.push(sec.name ? '## ' + sec.name : '##', '');
    for (const card of sec.cards) {
      out.push('<!-- card ' + metaStr(card.id, card.meta || {}) + ' -->');
      const body = normalizeBody(card.body);
      if (body) out.push(...body.split('\n').map(escapeLine));
      out.push('');
    }
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/** state.json: small shared settings like the date the weekly check was last done */
export function parseState(text) {
  if (!text || !String(text).trim()) return {};
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch (e) { return {}; }
}
export const serializeState = s => JSON.stringify(s, null, 2) + '\n';

export const allCards = doc => doc.sections.flatMap(s => s.cards);
