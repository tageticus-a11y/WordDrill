import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureText, captureUrl, bookmarklet, joinCapture, CAPTURE_MAX } from '../js/capture.js';
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
  const run = new Function('getSelection', 'window', 'document', b.slice('javascript:'.length));
  run(() => 'բառ & word', { open: (url, name) => { opened = [url, name]; } }, { activeElement: null });
  assert.equal(opened[1], 'worddrill-add');
  assert.deepEqual(captureText(new URL(opened[0]).search), { text: 'բառ & word', cut: false });
  // text selected inside a text box
  run(() => '', { open: url => { opened = [url]; } }, { activeElement: { tagName: 'TEXTAREA', value: 'abcdef', selectionStart: 1, selectionEnd: 4 } });
  assert.equal(captureText(new URL(opened[0]).search).text, 'bcd');
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
