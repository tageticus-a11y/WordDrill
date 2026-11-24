// One-time import of exported notes into an area's queue: blocks separated by empty lines become cards,
// written as queue/<key>/0001.md, 0002.md … (fileSize cards each) into a local copy of the Dropbox app
// folder (the Dropbox app uploads them). The source file is not touched. Real notes never go into the repo.
//
//   node scripts/import-queue.mjs <notes.txt> <area-key> <app-folder> [--size 50] [--drop <exact block>]... [--date YYYY-MM-DD]
//
// Refuses when the area already has a queue folder. Before writing, every file is parsed back and must give
// exactly the same blocks in the same order.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitBlocks, chunk, queuePath } from '../js/queue.js';
import { parseDoc, serializeDoc, hashId, allCards } from '../js/format.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : args.splice(i, 2)[1]; };
const size = +opt('--size', 50);
const date = opt('--date', new Date().toLocaleDateString('sv'));
const drop = [];
for (let d; (d = opt('--drop', null)) != null;) drop.push(d);
const [src, key, folder] = args;
if (!src || !key || !folder || !/^[a-z0-9-]+$/.test(key) || !(size > 0)) {
  console.error('usage: node scripts/import-queue.mjs <notes.txt> <area-key> <app-folder> [--size 50] [--drop <block>] [--date YYYY-MM-DD]');
  process.exit(2);
}
const dir = join(folder, 'queue', key);
if (existsSync(dir)) { console.error('Refusing: ' + dir + ' already exists.'); process.exit(1); }

const all = splitBlocks(readFileSync(src, 'utf8'));
const blocks = all.filter(b => !drop.includes(b));
console.log(`${all.length} blocks, ${all.length - blocks.length} dropped (${drop.join(', ') || 'none'}), ${blocks.length} cards`);

const used = new Set();
const out = chunk(blocks, size).map((part, f) => {
  const cards = part.map((body, i) => {
    let id = hashId(key + '\n' + (f * size + i) + '\n' + body);
    while (used.has(id)) id += 'x';
    used.add(id);
    return { id, meta: { added: date }, body };
  });
  return { path: queuePath(key, f + 1), text: serializeDoc({ version: 1, sections: [{ name: '', cards }] }) };
});

// Check: the files give back exactly the blocks, in order, all in section '' (no headings)
const back = out.flatMap(f => {
  const d = parseDoc(f.text);
  if (d.sections.some(s => s.name !== '')) throw new Error('heading in ' + f.path);
  return allCards(d).map(c => c.body);
});
if (back.length !== blocks.length || back.some((b, i) => b !== blocks[i])) {
  const i = back.findIndex((b, j) => b !== blocks[j]);
  throw new Error('round trip differs at card ' + i + '; nothing written');
}
for (const f of out) {
  mkdirSync(join(folder, 'queue', key), { recursive: true });
  writeFileSync(join(folder, f.path), f.text);
}
console.log(`wrote ${out.length} files to ${dir}: ${out[0]?.path} … ${out.at(-1)?.path} (last holds ${blocks.length - (out.length - 1) * size})`);
