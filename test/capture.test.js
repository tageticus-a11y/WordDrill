import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureText, captureMode, captureUrl, bookmarklet, joinCapture, CAPTURE_MAX } from '../js/capture.js';
import { splitParts } from '../js/ops.js';

const enc = s => '?add=' + encodeURIComponent(s);

test('capture text from the address: Unicode, + and %, CRLF, edges trimmed', () => {
  assert.equal(captureText('?demo'), null);
  assert.equal(captureText(''), null);
  assert.deepEqual(captureText('?add='), { text: '', cut: false });
  const t = '  բարեւ – привет\r\nC++ 100% a&b=c #1  \r\n\r\n';
  assert.deepEqual(captureText(enc(t)), { text: 'բարեւ – привет\nC++ 100% a&b=c #1', cut: false });
  assert.deepEqual(captureText('?demo&add=' + encodeURIComponent('word')), { text: 'word', cut: false });
});

test('a huge selection is cut, and says so', () => {
  const r = captureText(enc('x'.repeat(CAPTURE_MAX + 10)));
  assert.equal(r.text.length, CAPTURE_MAX);
  assert.equal(r.cut, true);
});

test('the bookmarklet opens the app with the selection, and is a valid script', () => {
  const b = bookmarklet('https://example.org/WordDrill/?demo#x');
  assert.ok(b.startsWith('javascript:'));
  assert.ok(b.includes('"https://example.org/WordDrill/?add="'));
  assert.ok(bookmarklet('http://localhost:8000/', true).includes('"http://localhost:8000/?demo&add="'));
  // runs: the selection goes into the address of the window it opens
  let opened;
  const run = top => {
    opened = null;
    new Function('window', b.slice('javascript:'.length))({ ...top, open: (url, name) => { opened = [url, name]; } });
    return captureText(new URL(opened[0]).search).text;
  };
  // a fake window: its selection, the focused element, its frames
  const win = (sel, frames = [], active = null) => ({ document: { activeElement: active }, getSelection: () => sel, frames });
  assert.equal(run(win('բառ & word')), 'բառ & word');
  assert.equal(opened[1], 'worddrill-add');
  // text selected inside a text box
  assert.equal(run(win('', [], { tagName: 'TEXTAREA', value: 'abcdef', selectionStart: 1, selectionEnd: 4 })), 'bcd');
});

test('the bookmarklet finds a selection inside frames (course players), skipping frames of other sites', () => {
  const b = bookmarklet('https://example.org/WordDrill/');
  let opened;
  const run = top => {
    new Function('window', b.slice('javascript:'.length))({ ...top, open: url => { opened = url; } });
    return captureText(new URL(opened).search).text;
  };
  const win = (sel, frames = [], active = null) => ({ document: { activeElement: active }, getSelection: () => sel, frames });
  // another site's frame: every access throws
  const foreign = { get document() { throw new Error('SecurityError'); }, getSelection() { throw new Error('SecurityError'); }, frames: [] };
  const iframe = { tagName: 'IFRAME' };
  assert.equal(run(win('', [win('frame text')], iframe)), 'frame text');
  assert.equal(run(win('', [win('', [win('nested text')])], iframe)), 'nested text');
  assert.equal(run(win('', [foreign, win('after the foreign one')])), 'after the foreign one');
  assert.equal(run(win('', [foreign])), '');
  assert.equal(run(win('top wins', [win('frame text')])), 'top wins');
  assert.equal(run(win('', [win('', [], { tagName: 'INPUT', value: 'in a box', selectionStart: 3, selectionEnd: 8 })])), 'a box');
});

test('text arriving while an unsaved capture is open is added after a ― line, so both are kept', () => {
  assert.equal(joinCapture('', 'new'), 'new');
  assert.equal(joinCapture('old\n', ''), 'old\n');
  const j = joinCapture('old one\n', 'new one');
  assert.deepEqual(splitParts(j, 'marks'), ['old one', 'new one']);
});

test('the address for the iPhone Shortcut: the app with ?add=, and the encoded text comes back exactly', () => {
  assert.equal(captureUrl('https://example.org/WordDrill/?x=1#top'), 'https://example.org/WordDrill/?add=');
  assert.equal(captureUrl('http://localhost:8000/?demo', true), 'http://localhost:8000/?demo&add=');
  assert.ok(bookmarklet('https://example.org/WordDrill/').includes(JSON.stringify(captureUrl('https://example.org/WordDrill/'))));
  // the Shortcut: Open URLs with the address + URL Encode(text)
  const text = 'բարեւ & привет\nC++ #1 50% a=b?c';
  const url = new URL(captureUrl('https://example.org/WordDrill/') + encodeURIComponent(text));
  assert.deepEqual(captureText(url.search), { text, cut: false });
});

test('which page this is: a capture page (?add=) or the WD Add app (?app=add)', () => {
  assert.deepEqual(captureMode(''), { capture: false, app: false });
  assert.deepEqual(captureMode('?demo'), { capture: false, app: false });
  assert.deepEqual(captureMode('?add=word'), { capture: true, app: false });
  assert.deepEqual(captureMode('?app=add'), { capture: true, app: true });
  assert.deepEqual(captureMode('?demo&app=add'), { capture: true, app: true });
  assert.deepEqual(captureMode('?app=other'), { capture: false, app: false });
});
