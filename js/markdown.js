// A small Markdown subset for card bodies: paragraphs (single newlines are line breaks), **bold**,
// *italic* / _italic_, > quotes, - lists, 1. lists, \ escapes. Parsing is pure (tested in Node);
// toDom builds DOM nodes with textContent only, so card text can never inject HTML.

const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;
const FENCE_RE = /^ {0,3}```/;   // ``` … ``` block: shown in a box as is (e.g. etymology)
const FENCE_END_RE = /^ {0,3}```[ \t]*$/;
// Table: a header row with |, then a delimiter row like | --- | :---: |, then rows with |
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** One table row → raw cell texts; \| stays in the cell (parseInline turns it into |) */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim());
}
const isTableAt = (lines, i) => i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('|')
  && TABLE_DELIM_RE.test(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

/** md → [{ t: 'p', lines: [inline[]] } | { t: 'quote', blocks } | { t: 'ul'|'ol', items: [inline[]] }] */
export function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE_RE.test(line)) {
      const inner = [];
      i++;
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) inner.push(lines[i++]);
      i++;   // the closing fence (or the end of the card)
      blocks.push({ t: 'code', text: inner.join('\n') });
    } else if (isTableAt(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        rows.push(head.map((_, j) => parseInline(cells[j] || '')));   // as many cells as the header
      }
      blocks.push({ t: 'table', align, head: head.map(parseInline), rows });
    } else if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(lines[i++].match(QUOTE_RE)[1]);
      blocks.push({ t: 'quote', blocks: parseBlocks(inner.join('\n')) });
    } else if (UL_RE.test(line) || OL_RE.test(line)) {
      const re = UL_RE.test(line) ? UL_RE : OL_RE, items = [];
      const start = parseInt(line.trim(), 10);
      while (i < lines.length && re.test(lines[i])) items.push(parseInline(lines[i++].match(re)[1]));
      // A numbered list keeps its first number: "2)" after a quote is item 2, not a new 1
      blocks.push(re === UL_RE ? { t: 'ul', items } : { t: 'ol', start, items });
    } else {
      const ls = [];
      while (i < lines.length && lines[i].trim() && !QUOTE_RE.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !FENCE_RE.test(lines[i])
        && !(ls.length && isTableAt(lines, i)))
        ls.push(parseInline(lines[i++].trim()));
      blocks.push({ t: 'p', lines: ls });
    }
  }
  return blocks;
}

// Groups: 1 escape, 2 `code`, 3 **bold**, 4 __bold__, 5 *italic*, 6 _italic_, 7 ~~underline~~, 8 ~underline~
const INLINE_RE = /\\([\\*_`>#\-+.!\[\]()~|])|`([^`\n]+)`|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])|~~(?=\S)([\s\S]*?\S)~~|~(?=[^\s~])([\s\S]*?[^\s~])~/gu;

/** text → [{ t: 'text', v } | { t: 'code', v } | { t: 'b'|'i'|'u', c: inline[] }] */
export function parseInline(s) {
  const out = [];
  const text = v => { if (!v) return; const last = out[out.length - 1]; if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  let at = 0, m;
  const re = new RegExp(INLINE_RE.source, 'gu');
  while ((m = re.exec(s))) {
    text(s.slice(at, m.index));
    if (m[1] != null) text(m[1]);
    else if (m[2] != null) out.push({ t: 'code', v: m[2] });
    else if (m[3] != null || m[4] != null) out.push({ t: 'b', c: parseInline(m[3] ?? m[4]) });
    else if (m[5] != null || m[6] != null) out.push({ t: 'i', c: parseInline(m[5] ?? m[6]) });
    else out.push({ t: 'u', c: parseInline(m[7] ?? m[8]) });
    at = re.lastIndex;
  }
  text(s.slice(at));
  return out;
}

/** Plain text without markup (search) */
export function plainText(md) {
  const inl = xs => xs.map(x => (x.t === 'text' || x.t === 'code' ? x.v : inl(x.c))).join('');
  const blk = bs => bs.map(b => b.t === 'p' ? b.lines.map(inl).join('\n') : b.t === 'quote' ? blk(b.blocks)
    : b.t === 'code' ? b.text : b.t === 'table' ? [b.head, ...b.rows].map(r => r.map(inl).join(' | ')).join('\n')
    : b.items.map(inl).join('\n')).join('\n');
  return blk(parseBlocks(md));
}

/** Builds DOM nodes (browser only) */
export function toDom(md, doc = document) {
  const el = (tag, kids) => { const e = doc.createElement(tag); kids.forEach(k => e.append(k)); return e; };
  const TAGS = { b: 'strong', i: 'em', u: 'u' };
  const inl = xs => xs.map(x => (x.t === 'text' ? doc.createTextNode(x.v)
    : x.t === 'code' ? el('code', [doc.createTextNode(x.v)]) : el(TAGS[x.t], inl(x.c))));
  const blk = bs => bs.map(b => {
    if (b.t === 'code') return el('pre', [doc.createTextNode(b.text)]);
    if (b.t === 'p') return el('p', b.lines.flatMap((l, i) => (i ? [doc.createElement('br'), ...inl(l)] : inl(l))));
    if (b.t === 'quote') return el('blockquote', blk(b.blocks));
    if (b.t === 'table') {
      const cell = (tag, c, j) => { const e = el(tag, inl(c)); if (b.align[j]) e.style.textAlign = b.align[j]; return e; };
      const table = el('table', [el('thead', [el('tr', b.head.map((c, j) => cell('th', c, j)))]),
        el('tbody', b.rows.map(r => el('tr', r.map((c, j) => cell('td', c, j)))))]);
      const wrap = el('div', [table]);
      wrap.className = 'table';   // scrolls sideways when wider than the card
      return wrap;
    }
    const list = el(b.t, b.items.map(it => el('li', inl(it))));
    if (b.t === 'ol' && b.start !== 1) list.setAttribute('start', b.start);
    return list;
  });
  const frag = doc.createDocumentFragment();
  blk(parseBlocks(md)).forEach(n => frag.append(n));
  return frag;
}

/* ---- Toolbar edits: (value, start, end) → { value, start, end } ---- */

/** Wraps the selection in mark (** or *), or unwraps it if it is already wrapped */
export function toggleWrap(value, start, end, mark) {
  const m = mark.length;
  const sel = value.slice(start, end);
  const outer = value.slice(start - m, start) === mark && value.slice(end, end + m) === mark
    && !(mark === '*' && value.slice(start - 2, start) === '**' && value.slice(end, end + 2) === '**' && value.slice(start - 3, start) !== '***');
  if (outer && start >= m) {
    return { value: value.slice(0, start - m) + sel + value.slice(end + m), start: start - m, end: end - m };
  }
  if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(m, sel.length - m);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  // Keep spaces around the selection outside the marks: "**word** " not "**word **"
  const lead = sel.match(/^\s*/)[0].length, trail = sel.length - sel.trimEnd().length;
  const s = start + lead, e = Math.max(s, end - trail);
  const v = value.slice(0, s) + mark + value.slice(s, e) + mark + value.slice(e);
  return { value: v, start: s + m, end: e + m };
}

/** Adds prefix ("> ", "- ", "1. ") to every non-blank selected line, or removes it if all have it */
export function toggleLinePrefix(value, start, end, prefix) {
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  let le = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  if (le < 0) le = value.length;
  const lines = value.slice(ls, le).split('\n');
  const re = prefix === '1. ' ? /^\d+[.)] / : new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const filled = lines.filter(l => l.trim());
  const all = filled.length > 0 && filled.every(l => re.test(l));
  let n = 0;
  const out = lines.map(l => {
    if (!l.trim() && lines.length > 1) return l;
    if (all) return l.replace(re, '');
    n++;
    return (prefix === '1. ' ? n + '. ' : prefix) + l;
  });
  const block = out.join('\n');
  const v = value.slice(0, ls) + block + value.slice(le);
  return { value: v, start: lines.length === 1 && !lines[0] ? ls + block.length : ls, end: ls + block.length };
}

/** Puts the selected lines in a ``` box, or takes them out if the box is right around them */
export function toggleFence(value, start, end) {
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  let le = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  if (le < 0) le = value.length;
  const block = value.slice(ls, le);
  const prevStart = ls > 0 ? value.lastIndexOf('\n', ls - 2) + 1 : -1;
  const prevLine = ls > 0 ? value.slice(prevStart, ls - 1) : null;
  let nextEnd = le < value.length ? value.indexOf('\n', le + 1) : -1;
  if (le < value.length && nextEnd < 0) nextEnd = value.length;
  const nextLine = le < value.length ? value.slice(le + 1, nextEnd) : null;
  if (prevLine != null && nextLine != null && FENCE_END_RE.test(prevLine) && FENCE_END_RE.test(nextLine)) {
    return { value: value.slice(0, prevStart) + block + value.slice(nextEnd), start: prevStart, end: prevStart + block.length };
  }
  return { value: value.slice(0, ls) + '```\n' + block + '\n```' + value.slice(le), start: ls + 4, end: ls + 4 + block.length };
}

/** The first non-empty line of a card: what a collapsed card shows in the weekly check */
/** (a table's first line shows only its first cell, so the rest of the row stays hidden) */
export function firstLine(md) {
  const lines = String(md || '').split('\n');
  const i = lines.findIndex(l => l.trim() && !FENCE_RE.test(l));
  if (i < 0) return '';
  return isTableAt(lines, i) ? splitRow(lines[i])[0] : lines[i].trim();
}

/** Inserts an empty table (2 columns, 2 rows) on the line after the cursor; the first cell is selected */
export function insertTable(value, start, end) {
  let le = value.indexOf('\n', end);
  if (le < 0) le = value.length;
  const before = value.slice(0, le), after = value.slice(le);
  const lead = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const table = '| Word | Meaning |\n| --- | --- |\n|  |  |\n|  |  |';
  const v = before + lead + table + (after.startsWith('\n\n') || !after ? '' : after.startsWith('\n') ? '\n' : '\n\n') + after;
  const s = before.length + lead.length + 2;
  return { value: v, start: s, end: s + 4 };
}
