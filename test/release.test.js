import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('service worker caches every app module', () => {
  const sw = read('sw.js');
  for (const f of readdirSync(new URL('../js/', import.meta.url)))
    assert.ok(sw.includes("'./js/" + f + "'"), 'sw.js SHELL is missing js/' + f);
});

test('app version and service worker cache version match', () => {
  const cache = read('sw.js').match(/const CACHE = 'worddrill-v(\d+)'/)[1];
  const app = read('js/app.js').match(/const APP_VERSION = '(\d+)'/)[1];
  assert.equal(app, cache, 'bump CACHE in sw.js and APP_VERSION in js/app.js together');
});

test('the Dropbox app key is set', () => {
  assert.match(read('js/dropbox.js'), /DROPBOX_APP_KEY = '[a-z0-9]{10,}'/);
});

const shell = () => JSON.parse(read('sw.js').match(/const SHELL = (\[[^\]]*\])/)[1].replace(/'/g, '"'));

test('every file the service worker caches exists', () => {
  for (const f of shell()) if (f !== './') assert.ok(existsSync(new URL('../' + f, import.meta.url)), f + ' is in SHELL but missing');
});

test('WD Add (add.html) is cached, deployed and has a manifest with its own icons', () => {
  for (const f of ['./add.html', './add.webmanifest', './icon-add-180.png', './icon-add-192.png', './icon-add-512.png'])
    assert.ok(shell().includes(f), f + ' missing from SHELL');
  const copy = read('.github/workflows/pages.yml').match(/cp -r ([^\n]+) _site\//)[1].split(/\s+/);
  for (const f of ['index.html', 'add.html', 'manifest.webmanifest', 'add.webmanifest', 'sw.js', 'js', 'icon-*.png']) assert.ok(copy.includes(f), f + ' is not deployed');
  const m = JSON.parse(read('add.webmanifest'));
  assert.equal(m.start_url, './add.html');
  assert.notEqual(m.id, JSON.parse(read('manifest.webmanifest')).id);
  for (const i of m.icons) assert.ok(existsSync(new URL('../' + i.src, import.meta.url)), i.src);
  const html = read('add.html');
  assert.match(html, /rel="manifest" href="add.webmanifest"/);
  assert.match(html, /apple-touch-icon" href="icon-add-180.png"/);
  assert.match(html, /app=add/);
});
