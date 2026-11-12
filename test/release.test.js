import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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
