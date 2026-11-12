// A small Markdown subset for card bodies: paragraphs (single newlines are line breaks), **bold**,
// *italic* / _italic_, > quotes, - lists, 1. lists, \ escapes. Parsing is pure (tested in Node);
// toDom builds DOM nodes with textContent only, so card text can never inject HTML.

const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;

/** md → [{ t: 'p', lines: [inline[]] } | { t: 'quote', blocks } | { t: 'ul'|'ol', items: [inline[]] }] */
export function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) inner.push(lines[i++].match(QUOTE_RE)[1]);
      blocks.push({ t: 'quote', blocks: parseBlocks(inner.join('\n')) });
    } else if (UL_RE.test(line) || OL_RE.test(line)) {
      const re = UL_RE.test(line) ? UL_RE : OL_RE, items = [];
      while (i < lines.length && re.test(lines[i])) items.push(parseInline(lines[i++].match(re)[1]));
      blocks.push({ t: re === UL_RE ? 'ul' : 'ol', items });
    } else {
      const ls = [];
      while (i < lines.length && lines[i].trim() && !QUOTE_RE.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]))
        ls.push(parseInline(lines[i++].trim()));
      blocks.push({ t: 'p', lines: ls });
    }
  }
  return blocks;
}

const INLINE_RE = /\\([\\*_`>#\-+.!\[\]()~])|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

/** text → [{ t: 'text', v } | { t: 'b'|'i', c: inline[] }] */
export function parseInline(s) {
  const out = [];
  const text = v => { if (!v) return; const last = out[out.length - 1]; if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  let at = 0, m;
  const re = new RegExp(INLINE_RE.source, 'gu');
  while ((m = re.exec(s))) {
    text(s.slice(at, m.index));
    if (m[1] != null) text(m[1]);
    else if (m[2] != null || m[3] != null) out.push({ t: 'b', c: parseInline(m[2] ?? m[3]) });
    else out.push({ t: 'i', c: parseInline(m[4] ?? m[5]) });
    at = re.lastIndex;
  }
  text(s.slice(at));
  return out;
}

/** Plain text without markup (search) */
export function plainText(md) {
  const inl = xs => xs.map(x => (x.t === 'text' ? x.v : inl(x.c))).join('');
  const blk = bs => bs.map(b => b.t === 'p' ? b.lines.map(inl).join('\n') : b.t === 'quote' ? blk(b.blocks) : b.items.map(inl).join('\n')).join('\n');
  return blk(parseBlocks(md));
}

/** Builds DOM nodes (browser only) */
export function toDom(md, doc = document) {
  const el = (tag, kids) => { const e = doc.createElement(tag); kids.forEach(k => e.append(k)); return e; };
  const inl = xs => xs.map(x => (x.t === 'text' ? doc.createTextNode(x.v) : el(x.t === 'b' ? 'strong' : 'em', inl(x.c))));
  const blk = bs => bs.map(b => {
    if (b.t === 'p') return el('p', b.lines.flatMap((l, i) => (i ? [doc.createElement('br'), ...inl(l)] : inl(l))));
    if (b.t === 'quote') return el('blockquote', blk(b.blocks));
    return el(b.t, b.items.map(it => el('li', inl(it))));
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
