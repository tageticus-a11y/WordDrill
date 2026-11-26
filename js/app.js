// UI: Today (current cards), Prepared (next cards), Weekly check, Archive, Settings. All changes go through the sync engine
// as ops (see js/ops.js, js/sync.js); the UI never writes files itself.

import { createDropbox, AuthError, REDIRECT_URI } from './dropbox.js';
import { createEngine } from './sync.js';
import { createDemoDropbox } from './demo.js';
import { allCards, normalizeBody } from './format.js';
import { today, weekday, WEEKDAYS, WEEK_FILES, isDue, monthLabel } from './dates.js';
import {
  CURRENT, STATE, PREPARED, addOp, editOp, deleteOp, restoreOp, orderOp, archiveOp, moveOp, stateOp,
  findCard, targetsOf, rememberPlan, toTodayOp, toPreparedOp, preparedShortage, backToTodayOp, sectionOp,
  sectionsList, activeSections, sectionKey, addSectionPlan, renameSectionPlan, removeSectionPlan, moveSectionPlan,
  splitPlan, splitAllPlan, splitParts, coverage, coverageText, mergePlan, queueAddOp, queueToPreparedPlan, queueToEndPlan, forgotPlan
} from './ops.js';
import { queueSettings, queueFiles, isQueueFile, queueNumber, queuePath, appendTarget, soonTarget, QUEUE_SECTION } from './queue.js';
import { createVersions } from './versions.js';
import { captureText, bookmarklet, joinCapture, CAPTURE_LOCK } from './capture.js';
import { mountTimer } from './timer-ui.js';
import { timerSettings, clampTotal, shortcutOf, shortcutLabel, matchesShortcut, DEFAULT_SHORTCUT } from './timer.js';
import { DEFAULT_CHECK_PROMPT, promptOf, recallFor, typedTexts, buildCheckText, copyShortcutOf, DEFAULT_COPY_SHORTCUT, checkTypedFor } from './recall.js';
import { toDom, plainText, toggleWrap, toggleLinePrefix, toggleFence, firstLine, insertTable, insertRule } from './markdown.js';

const APP_VERSION = '32';   // shown in Settings; keep in step with CACHE in sw.js
const CORE = [CURRENT, PREPARED, STATE, ...WEEK_FILES];
const $ = s => document.querySelector(s);

/* ============ Storage ============ */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { toast('Couldn’t save on this device: browser storage is full.', { error: true }); }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const DEMO = new URLSearchParams(location.search).has('demo');   // fake Dropbox in browser storage, for trying the UI
// Earlier texts of cards for this session only (sessionStorage): a safety net for autosave
const versions = createVersions({
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
});
const dbx = DEMO ? createDemoDropbox(store) : createDropbox(store);
// Capture window (?add=…, opened by the bookmarklet in Settings): works like a separate device with its own
// storage keys, so it never overwrites the pending changes of a WordDrill tab that is open at the same time.
// Its engine is made once it holds the capture lock (see startCapture).
const CAPTURE = new URLSearchParams(location.search).has('add');
const CAPTURE_KEY = DEMO ? 'demo.capture' : 'wd.capture';
const DRAFT_KEY = CAPTURE ? 'wd.captureDraft' : 'wd.draft';
let engine = CAPTURE ? null : createEngine({ api: dbx.api, storage: store, key: DEMO ? 'demo.data' : 'wd.data' });

/* ============ UI state ============ */
let tab = store.get('wd.tab') || 'today';
let checkDay = null;                        // weekday number picked in Weekly check; null = today
let archiveKey = null, archiveMonth = null, archiveQuery = '';
let prepArea = store.get('wd.prepArea');      // Preparation: the area sub-tab shown
let prepView = store.get('wd.prepView') === 'queue' ? 'queue' : 'prepared';   // Preparation: Prepared or Queue
const queueAt = {};                          // area key → the queue file shown (front by default)
let quickArea = store.get('wd.quickArea');   // How to add several cards at once (above an editor for new queue cards)
const manyHint = () => h('p', { class: 'note', text: 'One card: type and Save. Several: one per line, then ✂ Save line by line; or put ― lines between them (the ― button), then ✂ Save at ― lines.' });
const queueName = p => { const a = sectionsList(engine.state()).find(x => x.key === p.split('/')[1]); return (a ? a.name + ' ' : '') + 'queue'; };
/* ============ Capture window ============ */
let captureCut = false, captureReady = false;
// Saves at once; when everything is in Dropbox, says so and closes the window (the bookmarklet opened it)
async function captureSave(message) {
  updateStatus('Saving…');
  try { await engine.flush(); } catch (e) { handleErr(e); }
  updateStatus();
  render();
  if (engine.pending()) return;   // the view offers Try again
  toast(message || 'Saved.');
  setTimeout(() => { window.close(); toast('Saved. You can close this window.'); }, 1500);
}
function captureView() {
  const out = [];
  if (captureCut) out.push(h('p', { class: 'low', text: 'The selection was very long, so only its start is here.' }));
  if (engine.pending()) out.push(h('div', { class: 'reminder' },
    h('span', { text: 'Not saved to Dropbox yet (' + plural(engine.pending(), 'change') + '). It is kept here until it is.' }),
    btn('Try again', () => captureSave(), 'primary')));
  if (!captureReady) out.push(h('p', { class: 'empty', text: 'Loading…' }));
  else out.push(quickQueue());
  return out;
}
async function startCapture() {
  document.documentElement.classList.add('capture');
  document.title = 'Add to WordDrill';
  const got = captureText(location.search);
  history.replaceState(null, '', location.pathname + (DEMO ? '?demo' : ''));   // a reload never adds the text twice
  captureCut = !!(got && got.cut);
  // One capture engine at a time (another window, or the main app saving what one left behind)
  if (navigator.locks) await new Promise(res => navigator.locks.request(CAPTURE_LOCK, () => { res(); return new Promise(() => {}); }));
  engine = createEngine({ api: dbx.api, storage: store, key: CAPTURE_KEY });
  show('app');
  if (!dbx.connected()) {
    const text = got ? got.text : '';
    $('#view').replaceChildren(h('section', { class: 'sec' }, h('h2', { text: 'Add to a queue' }),
      h('p', { text: 'Sign in to Dropbox in WordDrill first (open WordDrill in this browser), then try again.' }),
      text ? h('pre', { class: 'captured', text }) : null,
      h('div', { class: 'row' }, text ? btn('Copy the text', () => copyText(text).then(ok => toast(ok ? 'Copied.' : 'Couldn’t copy.')), 'primary') : null,
        btn('Close', () => window.close()))));
    return;
  }
  render();
  await sync();   // the areas and queue settings (and saves what an earlier window left)
  // a note left open by an earlier window keeps its text; the new selection goes after it
  if (editing && !editing.id && isQueueFile(editing.path)) {
    if (got && got.text) editing = { ...editing, text: joinCapture(editing.text, got.text) };
  } else {
    const areas = activeSections(engine.state());
    const area = areas.find(a => a.key === quickArea) || areas[0];
    try {
      const t = await queueTarget(area.key, true);
      editing = { path: t.path, section: QUEUE_SECTION, id: null, index: t.index, text: got ? got.text : '', soon: true };
    } catch (e) { handleErr(e); }
  }
  captureReady = true;
  saveDraft(); render(); focusEditor();
}
// Main app: saves what a capture window couldn't (it closed before Dropbox answered), unless one is open now
async function flushCaptureLeftovers() {
  const d = store.get(CAPTURE_KEY);
  if (!d || !d.ops || !d.ops.length || !navigator.locks) return;
  try {
    await navigator.locks.request(CAPTURE_LOCK, { ifAvailable: true }, async lock => {
      if (lock) await createEngine({ api: dbx.api, storage: store, key: CAPTURE_KEY }).flush();
    });
  } catch (e) { console.error(e); }   // tried again on the next sync
}
// Settings → Add from any page: the bookmarklet
function captureSettings() {
  const code = bookmarklet(location.href, DEMO);
  return h('section', { class: 'sec' }, h('h2', { text: 'Add from any page' }),
    h('p', { class: 'note', text: 'In Chrome on a computer: drag this link to the bookmarks bar. Then select text on any page and click it: a small WordDrill window opens with the text, to put it into a queue (soon or at the end).' }),
    h('div', { class: 'row' },
      h('a', { class: 'bookmarklet', href: code, title: 'Drag me to the bookmarks bar', onclick: ev => { ev.preventDefault(); toast('Drag this link to the bookmarks bar.'); } }, '+ WordDrill'),
      btn('Copy the code', () => copyText(code).then(ok => toast(ok ? 'Copied. Paste it as the address (URL) of a new bookmark.' : 'Couldn’t copy.')), 'link')),
    h('p', { class: 'note', text: 'Not in Chrome’s PDF viewer or on chrome:// pages.' }));
}
// Today → Add to a queue: the area key picked
let editing = store.get(DRAFT_KEY);         // { path, section, id|null, index?, text } — survives reloads
let menuFor = null;                         // card id whose extra actions are shown
let renderPending = false;
let showLater = false;
const revealed = new Set();                 // Weekly check: cards whose answer is shown (collapsed by default)
let animateNext = false;                    // the next render slides cards to their new places
let timer = null;                           // the header timer (js/timer-ui.js)
let recordingShortcut = null;               // Settings: 'timer' / 'copy' while waiting for a new shortcut

// Recall: cards typed from memory (this browser only, for today) before Today's list is shown. The list is
// hidden at the start of a session, after a long break (LIST_HIDE_AFTER) and after a visit to Prepared; hiding
// clears the typed cards. (k = 'today': the code keeps the key so another list could use it again.)
const RECALL = { today: { key: 'wd.recall', shown: 'wd.listShown' } };
const recalls = { today: recallFor(store.get(RECALL.today.key), today()) };
store.del('wd.recallCheck');                // the weekly check had a Recall list until v18
// Weekly check: what is typed under each collapsed card (this browser only, for today), shown next to the card
let checkTyped = checkTypedFor(store.get('wd.checkTyped'), today());
const typedFor = id => { checkTyped = checkTypedFor(checkTyped, today()); return checkTyped.byId[id] || ''; };
const setTypedFor = (id, text) => {
  checkTyped = checkTypedFor(checkTyped, today());
  if (text.trim()) checkTyped.byId[id] = text; else delete checkTyped.byId[id];
  store.set('wd.checkTyped', checkTyped);
};
let focusRecall = null;                     // typed card to focus after the next render
const LIST_HIDE_AFTER = 30 * 60 * 1000;
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
};
const listShown = k => session.get(RECALL[k].shown) === today();
const setListShown = (k, on) => session.set(RECALL[k].shown, on ? today() : null);

/* ============ Small helpers ============ */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}
// Runs fn and puts the page back where it was: iOS scrolls on its own when a text box changes or
// shrinks for a moment (the editor then jumped to the top of the card)
function keepScroll(fn) {
  const x = window.scrollX, y = window.scrollY;
  fn();
  if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
}
// Fits a text box to its text. Growing needs no measuring; shrinking sets the height to auto for a
// moment, which makes the page shorter, so the scroll position is kept.
function fitHeight(t) {
  if (t.scrollHeight > t.clientHeight) { t.style.height = t.scrollHeight + 2 + 'px'; return; }
  keepScroll(() => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; });
}
// Changes only the part of the text that differs (a toolbar edit), instead of replacing the whole value,
// which moves the caret to the end and makes iOS scroll there and back
function replaceText(t, value) {
  const old = t.value;
  if (old === value) return;
  let a = 0;
  while (a < old.length && a < value.length && old[a] === value[a]) a++;
  let b = 0;
  while (b < old.length - a && b < value.length - a && old[old.length - 1 - b] === value[value.length - 1 - b]) b++;
  t.setRangeText(value.slice(a, value.length - b), a, old.length - b, 'preserve');
}
const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, onclick, title, 'aria-label': title }, text);
const shortDate = d => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

let toastTimer;
function toast(msg, opts = {}) {
  const el = $('#toast');
  el.replaceChildren(h('span', { text: msg }));
  if (opts.undo) el.append(btn('Undo', () => { el.className = ''; opts.undo(); }, 'link'));
  el.className = 'show' + (opts.error ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, opts.error ? 7000 : opts.undo ? 6000 : 2500);
}
const OFFLINE = 'Offline — changes are kept on this device';
function updateStatus(text) {
  if (!engine) return;   // a capture window still waiting for its engine
  const n = engine.pending();
  $('#sync').textContent = text || (!navigator.onLine ? OFFLINE : n ? plural(n, 'change') + ' to save' : 'Synced');
}
function show(id) { ['login', 'app'].forEach(s => { $('#' + s).hidden = s !== id; }); }

/* ============ Sync ============ */
function handleErr(e) {
  console.error(e);
  if (e instanceof AuthError) { show('login'); toast(e.message, { error: true }); return; }
  if (e instanceof TypeError) { updateStatus(OFFLINE); return; }
  toast(e.message, { error: true });
}
let flushTimer;
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 600); }
async function flush() {
  if (!engine) return;
  if (!dbx.connected() || !engine.pending()) return updateStatus();
  if (!navigator.onLine) return updateStatus();
  updateStatus('Saving…');
  try { await engine.flush(); updateStatus(); } catch (e) { handleErr(e); }
}
async function sync() {
  if (!engine || !dbx.connected()) return;
  if (!navigator.onLine) return updateStatus();
  updateStatus('Syncing…');
  try {
    if (CAPTURE) { await engine.sync([STATE]); updateStatus(); return; }
    await flushCaptureLeftovers();
    const changed = await engine.sync(CORE);
    if (changed.length) backgroundRender();
    updateStatus();
  } catch (e) { handleErr(e); }
}
// ops / undo: one op or a list; Undo in the toast commits the undo ops
function commit(ops, message, undo) {
  [ops].flat().forEach(op => engine.add(op));
  animateNext = true;
  render();
  if (CAPTURE) { captureSave(message); return; }
  scheduleFlush();
  if (message) toast(message, undo && [undo].flat().length ? { undo: () => commit(undo) } : {});
}

/* ============ Motion ============ */
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// The card slides out (to the right, or to the left when it goes to a tab on the left), then the change
// is made (and the cards below move up)
function leave(ev, fn, dir) {
  const el = ev && ev.currentTarget && ev.currentTarget.closest('.card');
  if (!el || reducedMotion() || !el.animate) return fn();
  el.querySelectorAll('button').forEach(b => { b.disabled = true; });
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(' + (dir === 'left' ? -48 : 48) + 'px)' }],
    { duration: 200, easing: 'ease-in', fill: 'forwards' }).finished.then(fn, fn);
}
const cardRects = () => new Map([...document.querySelectorAll('#view .card[data-id]')].map(e => [e.dataset.id, e.getBoundingClientRect().top]));
// FLIP: cards that moved glide from their old place; cards that just appeared rise from below
function playMoves(before) {
  for (const el of document.querySelectorAll('#view .card[data-id]')) {
    if (!el.animate) return;
    const old = before.get(el.dataset.id);
    if (old != null) {
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }],
        { duration: 380, easing: 'cubic-bezier(.2, .7, .3, 1)' });
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(56px)' }, { opacity: 1, transform: 'none' }],
        { duration: 650, delay: 150, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'backwards' });
    }
  }
}

/* ============ Editing ============ */
function saveDraft() { if (editing) store.set(DRAFT_KEY, editing); else store.del(DRAFT_KEY); }
function startEdit(path, section, card, index) {
  if (editing) {
    if (editing.id === (card && card.id) && editing.path === path) return;
    autoSave();
  }
  editing = { path, section, id: card ? card.id : null, index, text: card ? card.body : '' };
  saveDraft();
  render();
  focusEditor();
}
function focusEditor() {
  const t = $('.editor textarea');
  if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.scrollIntoView({ block: 'nearest' }); }
}
function closeEditor() {
  editing = null; saveDraft();
  render();
}
function saveEdit() {
  const e = editing, text = normalizeBody(e.text);
  if (!text) { toast(e.id ? 'The card is empty. To remove it, use Delete.' : 'Type something first.'); return; }
  if (!e.id) {
    closeEditor();
    if (isQueueFile(e.path)) {
      commit(queueAddOp({ path: e.path, index: e.index }, text, today()), 'Added to the ' + queueName(e.path) + ': file ' + queueNumber(e.path) + ', card ' + ((e.index || 0) + 1) + '.');
    } else commit(addOp(e.path, e.section, text, today()));
    return;
  }
  const f = findCard(engine.doc(e.path), e.id);
  const card = f ? f.card : { id: e.id, meta: {} };
  closeEditor();
  if (!f || f.card.body !== text) {
    if (f) versions.add(e.id, f.card.body);
    commit(editOp(e.path, e.section, card, text));
  }
}
// The open card is saved when the focus leaves it: a tap or click outside the editor, another tab,
// leaving the app. Save stays as a button. An empty card is not saved (Delete removes cards).
function autoSave() {
  if (!editing) return;
  if (CAPTURE) { saveDraft(); return; }
  if (!normalizeBody(editing.text)) {
    const id = editing.id;
    closeEditor();
    if (id) toast('An empty card isn’t saved. To remove a card, use Delete.');
    return;
  }
  saveEdit();
}
function renderEditor() {
  const e = editing;
  const t = h('textarea', { rows: 3, spellcheck: 'true', autocapitalize: 'sentences', placeholder: 'Word, meaning, examples…' });
  t.value = e.text;
  const grow = () => fitHeight(t);
  const set = r => { replaceText(t, r.value); t.setSelectionRange(r.start, r.end); e.text = t.value; saveDraft(); grow(); };
  const wrap = m => set(toggleWrap(t.value, t.selectionStart, t.selectionEnd, m));
  const prefix = p => set(toggleLinePrefix(t.value, t.selectionStart, t.selectionEnd, p));
  t.addEventListener('input', () => { e.text = t.value; saveDraft(); grow(); splitButtons(); });
  t.addEventListener('keydown', ev => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key === 'Enter') { ev.preventDefault(); saveEdit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
    else if (mod && ev.key.toLowerCase() === 'b') { ev.preventDefault(); wrap('**'); }
    else if (mod && ev.key.toLowerCase() === 'i') { ev.preventDefault(); wrap('*'); }
    else if (mod && ev.key.toLowerCase() === 'u') { ev.preventDefault(); wrap('~'); }
  });
  t.addEventListener('blur', () => {
    if (renderPending) setTimeout(() => { if (renderPending && !typingFocused()) render(); }, 0);
    // Focus moved elsewhere without a click (keyboard, or a tap on iOS that makes no click event).
    // Clicks are handled earlier, in the document click listener. Switching windows is not leaving.
    setTimeout(() => {
      if (editing === e && !editorFocused() && document.hasFocus() && !(document.activeElement && document.activeElement.closest('.editor'))) autoSave();
    }, 400);
  });
  requestAnimationFrame(grow);
  // Split into many cards: at the --- lines (the ― button marks the places), or every line its own card
  const many = mode => h('button', { type: 'button', class: 'split', onmousedown: ev => ev.preventDefault(), onclick: () => splitAllEdit(mode),
    title: mode === 'marks' ? 'Split the card at every ― line (--- on a line of its own)' : 'Every non-empty line becomes a card of its own' },
    (e.id ? '✂ ' : '✂ Save ') + (mode === 'marks' ? 'at ― lines' : 'line by line').replace(/^./, c => e.id ? c.toUpperCase() : c));
  const atMarks = many('marks'), byLine = many('lines');
  const splitButtons = () => {
    // always shown (so they can be found), dimmed while there is nothing to split; a tap then explains
    atMarks.classList.toggle('idle', splitParts(t.value, 'marks').length < 2);
    byLine.classList.toggle('idle', splitParts(t.value, 'lines').length < 2);
  };
  splitButtons();
  // Toolbar buttons keep the focus (and the selection) in the text box
  const tool = (label, title, fn, cls) => h('button', { type: 'button', class: 'tool ' + (cls || ''), title, 'aria-label': title,
    onmousedown: ev => ev.preventDefault(), onclick: () => keepScroll(() => { t.focus({ preventScroll: true }); fn(); }) }, label);
  const keep = (label, fn, cls) => h('button', { type: 'button', class: cls, onmousedown: ev => ev.preventDefault(), onclick: fn }, label);
  // Earlier texts of this card from this session; picking one puts it in the text box
  const earlier = e.id ? versions.list(e.id) : [];
  const list = h('div', { class: 'versions', hidden: true },
    h('p', { class: 'note', text: 'Earlier texts of this card from this session. Tap one to put it back in the box.' }),
    earlier.map(v => keep([h('span', { class: 'when', text: new Date(v.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }),
      h('span', { class: 'what', text: plainText(v.text).split('\n').join(' · ') })], () => {
      versions.add(e.id, e.text);
      keepScroll(() => { t.value = v.text; e.text = v.text; saveDraft(); grow(); t.focus({ preventScroll: true }); });
    }, 'version')));
  return h('div', { class: 'editor' },
    h('div', { class: 'toolbar' },
      tool('B', 'Bold (Ctrl+B)', () => wrap('**'), 'b'), tool('I', 'Italic (Ctrl+I)', () => wrap('*'), 'i'),
      tool('U', 'Underline (Ctrl+U): ~text~', () => wrap('~'), 'u'),
      tool('H', 'Heading: # at the start of the line', () => prefix('# '), 'h'), tool('❝', 'Quote', () => prefix('> ')), tool('•', 'List', () => prefix('- ')), tool('1.', 'Numbered list', () => prefix('1. ')),
      tool('{ }', 'Box, e.g. for etymology', () => set(toggleFence(t.value, t.selectionStart, t.selectionEnd)), 'box'),
      tool('⊞', 'Table', () => set(insertTable(t.value, t.selectionStart, t.selectionEnd)), 'table'),
      tool('―', 'Line (---); also marks where ✂ At ― lines splits the card', () => { set(insertRule(t.value, t.selectionStart, t.selectionEnd)); splitButtons(); }, 'rule'),
      earlier.length ? tool('↺ ' + earlier.length, 'Earlier versions', () => { list.hidden = !list.hidden; }, 'hist') : null),
    t,
    list,
    h('div', { class: 'row' }, keep('Save', saveEdit, 'primary'), keep('Cancel', cancelEdit),
      h('span', { class: 'splits' }, e.id ? h('button', { type: 'button', class: 'split', title: 'Split the card at the cursor: the text after it becomes a new card below',
        onmousedown: ev => ev.preventDefault(), onclick: () => splitEdit(t.selectionStart) }, '✂ Split here') : null,
      atMarks, byLine)));
}
// Splits the text being edited into many cards (mode: 'marks' or 'lines', see splitParts). A saved card keeps the
// first part and the others go right below it; a new card is saved as that many cards.
function splitAllEdit(mode) {
  const e = editing;
  if (!e) return;
  const parts = splitParts(e.text, mode);
  if (parts.length < 2) { toast(mode === 'marks' ? 'Put ― lines (---) where the cards should be cut, then tap again.' : 'There is only one line.'); return; }
  if (!e.id) {
    closeEditor();
    const date = today(), queue = isQueueFile(e.path);
    const ops = parts.map((body, j) => queue ? queueAddOp({ path: e.path, index: (e.index || 0) + j }, body, date) : addOp(e.path, e.section, body, date));
    commit(ops, 'Added ' + parts.length + ' cards' + (queue ? ' to the ' + queueName(e.path) + ': file ' + queueNumber(e.path) + (e.index < 1e9 ? ', from card ' + ((e.index || 0) + 1) : '') : '') + '.',
      ops.map(o => deleteOp(o.path, o.card.id)));
    return;
  }
  const f = findCard(engine.doc(e.path), e.id);
  if (!f) return;
  const p = splitAllPlan(e.path, f.section.name, f.card, f.index, parts);
  if (f.card.body !== e.text) versions.add(e.id, f.card.body);
  if (revealed.has(e.id)) p.cards.forEach(c => revealed.add(c.id));
  closeEditor();
  commit(p.ops, 'Split into ' + parts.length + ' cards.', p.undo);
}
// Splits the card being edited at the cursor: the text before it stays, the rest becomes a new card below
function splitEdit(pos) {
  const e = editing, f = e && e.id && findCard(engine.doc(e.path), e.id);
  if (!f) return;
  const p = splitPlan(e.path, f.section.name, f.card, f.index, e.text, pos);
  if (!p) { toast('Put the cursor where the second card should start, then tap Split here.'); return; }
  if (f.card.body !== e.text) versions.add(e.id, f.card.body);
  if (revealed.has(e.id)) revealed.add(p.card.id);
  closeEditor();
  commit(p.ops, 'Split into two cards.', p.undo);
}
// Joins a card with the next one (the lower card's text goes to the end of the upper one)
function mergeButton(path, section, card, next, nextIndex) {
  return next ? btn('Merge with next', ev => leave(ev, () => {
    menuFor = null;
    const p = mergePlan(path, section, card, next, nextIndex);
    commit(p.ops, 'Merged into one card.', p.undo);
  }), null, 'Join this card with the one below it') : null;
}
function cancelEdit() {
  const e = editing;
  const f = e.id && findCard(engine.doc(e.path), e.id);
  const original = e.id ? (f ? f.card.body : '') : '';
  if (normalizeBody(e.text) !== normalizeBody(original) && !confirm('Discard your changes to this card?')) return;
  closeEditor();
  if (CAPTURE) window.close();
}
const editorFocused = () => !!document.activeElement && document.activeElement.matches('.editor textarea');
const typingFocused = () => !!document.activeElement && document.activeElement.matches('.editor textarea, .typed textarea, textarea.prompt, input.area-name');

/* ============ Cards ============ */
// "Move to…" another section of the same file; Undo puts the card back in its place
function sectionPicker(path, section, card, index) {
  const others = activeSections(engine.state()).map(x => x.name).filter(n => n !== section);
  return h('select', { class: 'move-sec', 'aria-label': 'Move to section', onchange: ev => {
    const to = ev.target.value;
    menuFor = null;
    commit(sectionOp(path, card.id, to), 'Moved to ' + to + '.', sectionOp(path, card.id, section, index));
  } }, h('option', { value: '', selected: true, disabled: true }, 'Move to…'), others.map(n => h('option', { value: n }, n)));
}

// typed: what the user typed for this card (Weekly check), shown side by side with the card
function cardView(card, { path, section, actions = [], meta, editable = true, typed }) {
  if (editing && editing.path === path && editing.id === card.id) return renderEditor();
  // Read-only: the text is there to select and copy; ✎ Edit (next to the main button) opens the editor
  const body = h('div', { class: 'md' });
  body.append(toDom(card.body));
  if (editable) actions = [...actions.slice(0, 1), btn('✎ Edit', () => startEdit(path, section, card), 'edit'), ...actions.slice(1)];
  const main = typed
    ? h('div', { class: 'compare' },
      h('div', { class: 'compare-typed' }, h('div', { class: 'label', text: 'You typed' }), h('div', { class: 'typed-text', text: typed })),
      h('div', { class: 'compare-card' }, h('div', { class: 'label', text: 'Card' }), body))
    : body;
  return h('article', { class: 'card', 'data-id': card.id }, main,
    meta ? h('div', { class: 'meta', text: meta }) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}
// The active areas in their order, then any other heading in the file that holds cards (nothing is hidden)
const sectionsOf = doc => {
  const names = activeSections(engine.state()).map(s => s.name);
  const extra = doc.sections.filter(s => s.cards.length).map(s => s.name).filter((n, i, a) => !names.includes(n) && a.indexOf(n) === i);
  return names.concat(extra).map(name => ({ name, cards: (doc.sections.find(s => s.name === name) || { cards: [] }).cards }));
};

/* ============ Today and Prepared ============ */
// Both tabs show the same three sections; path is CURRENT or PREPARED
function renderList(path) {
  const date = today(), doc = engine.doc(path), isToday = path === CURRENT;
  const targets = targetsOf(engine.state());
  const dateLine = () => h('p', { class: 'date', text: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) });
  if (isToday && !listShown('today')) {
    const counts = sectionsOf(doc).filter(sec => sec.cards.length || targets[sec.name]).map(sec => sec.name + ' ' + sec.cards.length + covers(sec.name, targets)).join(' · ');
    return [dateLine(), recallPanel('today', 'today’s cards'),
      h('p', { class: 'note hidden-list', text: 'Today’s cards are hidden: ' + (counts || 'none') + '.' }),
      reminder(date), preparedReminder(), quickQueue()];
  }
  const out = isToday ? [dateLine(), recallBar('today')] : [];
  let secs = sectionsOf(doc);
  if (!isToday) {
    // Preparation: one sub-tab per area with its count; red when it holds less than a day's target
    const names = secs.map(s => s.name), areas = sectionsList(engine.state());
    if (editing && editing.path === path && names.includes(editing.section)) { prepArea = editing.section; prepView = 'prepared'; }
    if (editing && isQueueFile(editing.path)) {   // a queue card (or a new one) is being edited: show it
      const area = areas.find(a => a.key === editing.path.split('/')[1]);
      if (area && names.includes(area.name)) { prepArea = area.name; prepView = 'queue'; queueAt[area.key] = editing.path; }
    }
    if (!names.includes(prepArea)) prepArea = names[0];
    out.push(h('div', { class: 'subtabs', role: 'tablist' }, secs.map(sec => {
      const target = targets[sec.name] || 0, low = target > 0 && sec.cards.length < target, on = sec.name === prepArea;
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(on), class: 'subtab' + (on ? ' on' : '') + (low ? ' low' : ''),
        title: plural(sec.cards.length, 'card') + ' prepared' + (target ? ', ' + target + ' a day' : '') + (low ? ': not enough for tomorrow' : ''),
        onclick: () => openPrepArea(sec.name) },
        sec.name || 'No area', h('span', { class: 'n', text: String(sec.cards.length) }));
    })));
    secs = secs.filter(s => s.name === prepArea);
    // Prepared (the next cards, in order) or Queue (raw notes waiting to be prepared); only real areas have a queue
    const area = activeSections(engine.state()).find(a => a.name === prepArea);
    const view = area ? prepView : 'prepared';
    if (area) out.push(h('div', { class: 'seg', role: 'tablist' },
      [['prepared', 'Prepared ' + (secs[0] ? secs[0].cards.length : 0)], ['queue', 'Queue']].map(([v, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(v === view), class: v === view ? 'on' : null,
          onclick: () => { prepView = v; store.set('wd.prepView', v); menuFor = null; render(); } }, label))));
    if (view === 'queue') return out.concat(renderQueue(area));
    out.push(h('p', { class: 'date', text: 'Next cards, top first. ✓ (Remembered) in Today brings the top card of the same area into Today.' }));
  }
  for (const sec of secs) {
    const ids = sec.cards.map(c => c.id);
    const target = targets[sec.name] || 0;
    const cards = sec.cards.map((card, i) => {
      const swap = j => { const n = ids.slice(); [n[i], n[j]] = [n[j], n[i]]; commit(orderOp(path, sec.name, n)); };
      const more = menuFor === card.id;
      const main = isToday
        ? h('button', { type: 'button', class: 'primary remember', title: 'Remembered', 'aria-label': 'Remembered', onclick: ev => leave(ev, () => {
          const plan = rememberPlan(engine.doc(CURRENT), engine.doc(PREPARED), sec.name, card, date, target);
          commit(plan.ops, 'Moved to ' + weekday(date).name + '’s check.' + (plan.refill ? ' Next card added from Preparation.' : ''), plan.undo);
        }) }, '✓')
        : btn('← Today', ev => leave(ev, () => commit(toTodayOp(sec.name, card, date), 'Moved to Today.', moveOp(CURRENT, PREPARED, sec.name, card, {}, i)), 'left'), 'primary');
      const actions = [main, btn('⋯', () => { menuFor = more ? null : card.id; render(); }, 'icon' + (more ? ' on' : ''), 'More actions')];
      if (more) actions.push(h('span', { class: 'more' },
        h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => swap(i - 1) }, '↑'),
        h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === sec.cards.length - 1, onclick: () => swap(i + 1) }, '↓'),
        sectionPicker(path, sec.name, card, i),
        mergeButton(path, sec.name, card, sec.cards[i + 1], i + 1),
        isToday ? btn('Preparation →', ev => leave(ev, () => { menuFor = null; commit(toPreparedOp(sec.name, card), 'Moved back to the top of Preparation.', moveOp(PREPARED, CURRENT, sec.name, card, {}, i)); })) : null,
        btn('Delete', ev => leave(ev, () => { menuFor = null; commit(deleteOp(path, card.id), 'Card deleted.', restoreOp(path, sec.name, card, i)); }), 'danger')));
      return cardView(card, { path, section: sec.name, actions });
    });
    const adding = editing && editing.path === path && !editing.id && editing.section === sec.name;
    const low = !isToday && target > 0 && sec.cards.length < target;
    out.push(h('section', { class: 'sec' },
      isToday ? h('h2', {}, sec.name, h('span', { class: 'count', text: sec.cards.length + ' / ' + target }), coverView(sec.name, target))
        : low ? h('p', { class: 'low', text: (sec.cards.length ? 'Less than a day’s ' + target + ': not enough for tomorrow.' : 'Empty: nothing for tomorrow.') }) : null,
      cards,
      adding ? renderEditor() : btn('+ Add', () => startEdit(path, sec.name, null), 'add')));
  }
  if (isToday) out.push(reminder(date), preparedReminder(), quickQueue());
  return out;
}
// How many days Preparation lasts for an area (P prepared / T a day), shown on Today: "(2.5 days, 250%)"
const preparedCount = name => (sectionsOf(engine.doc(PREPARED)).find(s => s.name === name) || { cards: [] }).cards.length;
const covers = (name, targets) => { const c = coverage(preparedCount(name), targets[name]); return c ? ' ' + coverageText(c) : ''; };
function coverView(name, target) {
  const c = coverage(preparedCount(name), target);
  return c ? h('span', { class: 'cover' + (c.days < 1 ? ' low' : ''), title: 'Preparation lasts ' + c.days + (c.days === 1 ? ' day' : ' days') + ' at ' + target + ' a day', text: coverageText(c) }) : null;
}
/* ============ Recall ============ */
// k: 'today' (the only Recall list now)
function curRecall(k) { if (recalls[k].date !== today()) recalls[k] = recallFor(null, today()); return recalls[k]; }
const saveRecall = k => store.set(RECALL[k].key, recalls[k]);
const newRecallId = () => Math.random().toString(36).slice(2, 9);
const restoreTyped = (k, items) => { curRecall(k).items = items; saveRecall(k); render(); };
// recall.shown: the list was shown after this round of typing; the next Recall panel starts a new round
function showList(k) {
  const r = curRecall(k);
  r.shown = true; saveRecall(k);
  setListShown(k, true); animateNext = true; render(); window.scrollTo(0, 0);
}
const editingIn = k => !!editing && k === 'today' && editing.path === CURRENT;
// Hides a list again (not while one of its cards is being edited)
function hideList(k) { if (!editingIn(k)) setListShown(k, false); }
// Clears the typed cards (with Undo); hide: also hides the list again
function clearRecall(k, hide) {
  const r = curRecall(k), old = r.items.slice();
  r.items = []; r.shown = false; saveRecall(k);
  if (hide) setListShown(k, false);
  render();
  if (hide) window.scrollTo(0, 0);
  if (typedTexts({ items: old }).length) toast('Typed cards cleared.', { undo: () => restoreTyped(k, old) });
}
// The real cards a list is checked against
const recallCards = () => sectionsOf(engine.doc(CURRENT));
// Hover text of the Copy for AI check buttons: with the current shortcut
const copyTitle = () => { const sc = copyShortcutOf(engine.state()); return 'Copy for AI check' + (sc ? ' (' + shortcutLabel(sc) + ')' : ''); };
function copyCheck(k) {
  const text = buildCheckText(promptOf(engine.state()), typedTexts(curRecall(k)), recallCards(k));
  copyText(text).then(ok => toast(ok ? 'Copied: the prompt, your typed cards and the real cards. Paste it into the AI chat.'
    : 'Couldn’t copy to the clipboard.', ok ? {} : { error: true }));
}
// Clipboard: the API where allowed, else the old select-and-copy way
function copyText(text) {
  const old = () => {
    const t = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
    t.value = text; document.body.append(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    t.remove();
    return ok;
  };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, old);
  return Promise.resolve(old());
}
// Above a shown list: what was typed, Copy for AI check, Hide and type again
function recallBar(k) {
  const n = typedTexts(curRecall(k)).length;
  return h('div', { class: 'bar recall-bar' },
    h('span', { class: 'note', text: n ? 'Typed from memory: ' + plural(n, 'card') + '.' : 'Nothing typed from memory.' }),
    n ? btn('Copy for AI check', () => copyCheck(k), null, copyTitle()) : null,
    btn('Hide and type again', () => clearRecall(k, true), 'link'));
}
// The typing boxes shown instead of a hidden list; what: "today’s cards" / "the cards to check"
function recallPanel(k, what) {
  const r = curRecall(k);
  if (r.shown) {
    // The list was shown since these were typed: a new round starts empty (Undo brings them back)
    const old = r.items.slice();
    r.items = []; r.shown = false; saveRecall(k);
    if (typedTexts({ items: old }).length) setTimeout(() => toast('Typed cards from the last round were cleared.', { undo: () => restoreTyped(k, old) }));
  }
  if (!r.items.length) r.items.push({ id: newRecallId(), text: '' });   // always one box to type in
  const addAfter = it => {
    const n = { id: newRecallId(), text: '' };
    r.items.splice(r.items.indexOf(it) + 1, 0, n);
    saveRecall(k); focusRecall = n.id; render();
  };
  const remove = it => {
    const i = r.items.indexOf(it);
    r.items.splice(i, 1); saveRecall(k);
    if (r.items.length) focusRecall = r.items[Math.max(0, i - 1)].id;
    render();
  };
  // Enter: to an empty box right below, or a new one; nothing from an empty box (no piles of empty cards)
  const next = it => {
    if (!String(it.text || '').trim()) return;
    const below = r.items[r.items.indexOf(it) + 1];
    if (below && !String(below.text || '').trim()) {
      const b = document.querySelector('.recall textarea[data-rid="' + below.id + '"]');
      if (b) { b.focus(); return; }
    }
    addAfter(it);
  };
  const box = (it, i) => {
    // No spellcheck or autocorrect: the point is to see your own spelling
    const t = h('textarea', { rows: 1, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off',
      placeholder: i ? 'Next card' : 'Type a card from memory', 'aria-label': 'Card ' + (i + 1), 'data-rid': it.id });
    t.value = it.text;
    const grow = () => fitHeight(t);
    t.addEventListener('input', () => { it.text = t.value; saveRecall(k); grow(); updateRecallButtons(); });
    // Enter (Return on the phone) starts the next card; Shift+Enter adds a line inside this one. Backspace in an
    // empty box stays there (it never runs on into the card above); ✕ removes a box.
    let lineBreak = false;
    t.addEventListener('beforeinput', ev => {
      // The phone's keyboards (also custom ones) send Return as an input, not always as a key press
      const enter = ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph' || (ev.inputType === 'insertText' && ev.data === '\n');
      if (!enter) return;
      if (lineBreak) { lineBreak = false; return; }
      ev.preventDefault();
      next(it);
    });
    t.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey) { lineBreak = true; return; }
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); next(it); }
      // ↓ on the last line goes to the box below, ↑ on the first line to the box above (nothing past the ends)
      else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const down = ev.key === 'ArrowDown';
        const edge = down ? !t.value.slice(t.selectionEnd).includes('\n') : !t.value.slice(0, t.selectionStart).includes('\n');
        if (!edge) return;
        ev.preventDefault();
        const to = r.items[r.items.indexOf(it) + (down ? 1 : -1)];
        const box = to && document.querySelector('.recall textarea[data-rid="' + to.id + '"]');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      }
    });
    t.addEventListener('blur', () => { if (renderPending) setTimeout(() => { if (renderPending && !typingFocused()) render(); }, 0); });
    requestAnimationFrame(grow);
    return h('div', { class: 'typed' }, h('span', { class: 'num', text: (i + 1) + '.' }), t,
      btn('✕', () => remove(it), 'icon', 'Remove'));
  };
  const count = h('span', { class: 'count' });
  const showBtn = btn('', () => showList(k), 'primary');
  const copyBtn = btn('Copy for AI check', () => copyCheck(k), null, copyTitle());
  const clearBtn = btn('Clear', () => clearRecall(k, false), 'link');
  // Kept up to date while typing (no redraw, so the text box keeps the focus)
  updateRecallButtons = () => {
    const n = typedTexts(r).length;
    count.textContent = String(n);
    showBtn.textContent = (n ? 'Show ' : 'Skip — show ') + what;
    copyBtn.hidden = clearBtn.hidden = !n;
  };
  updateRecallButtons();
  return h('section', { class: 'sec recall' },
    h('h2', {}, 'Recall', count),
    h('p', { class: 'note', text: 'Type every card you remember, in any order, then show ' + what + '. Enter (Return) starts the next card, Shift+Enter a new line in a card. Kept on this device only, for today.' }),
    r.items.map(box),
    btn('+ Next card', () => addAfter(r.items[r.items.length - 1]), 'add', '+ Next card (Enter)'),
    h('div', { class: 'row' }, showBtn, copyBtn, clearBtn));
}
let updateRecallButtons = () => {};

function preparedReminder() {
  const short = preparedShortage(engine.doc(PREPARED), targetsOf(engine.state()));
  if (!short.length) return null;
  return h('div', { class: 'reminder' },
    h('span', { text: 'Preparation is running low: ' + short.map(x => x.section + ' ' + x.have + ' of ' + x.need).join(', ') + '.' }),
    btn('Open Preparation', () => { prepArea = short[0].section; setTab('prepared'); }, 'primary'));
}
/* ============ Queue ============ */
// Raw notes waiting to be prepared, per area: queue/<key>/0001.md … (js/queue.js). Front first. The files
// are loaded when shown or needed; a file left without cards is deleted by the sync engine.
const queuePaths = key => queueFiles(engine.paths('queue/' + key + '/'), key);
const queueCount = p => allCards(engine.doc(p)).length;
const queueLoading = new Set(), queueFailed = new Set();
function loadQueueFile(p) {
  if (queueLoading.has(p) || queueFailed.has(p)) return;
  queueLoading.add(p);
  engine.load(p).then(() => { queueLoading.delete(p); backgroundRender(); },
    e => { queueLoading.delete(p); queueFailed.add(p); handleErr(e); render(); });
}
/** Where a new card goes: soon (after the first soonAfter cards) or the end; loads the files it needs */
async function queueTarget(key, soon) {
  const paths = queuePaths(key), set = queueSettings(engine.state()), files = [];
  try {
    if (soon) {
      let seen = 0;
      for (const p of paths) {
        await engine.load(p);
        files.push({ path: p, count: queueCount(p) });
        if ((seen += files[files.length - 1].count) >= set.soonAfter) break;
      }
      return soonTarget(files, key, set);
    }
    if (paths.length) { const p = paths[paths.length - 1]; await engine.load(p); files.push({ path: p, count: queueCount(p) }); }
    return appendTarget(files, key, set);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    // Offline with the files not on this device: soon → into the front file (about the right place), end → the last file
    return soon ? { path: paths[0] || queuePath(key, 1), index: set.soonAfter } : { path: paths[paths.length - 1] || queuePath(key, 1), index: 1e9 };
  }
}
// Today → Add to a queue: a note goes into the picked area's queue, soon or at the end, without leaving Today
function quickQueue() {
  const areas = activeSections(engine.state());
  if (!areas.length) return null;
  const adding = editing && !editing.id && isQueueFile(editing.path) ? editing : null;
  const area = areas.find(a => a.key === (adding ? adding.path.split('/')[1] : quickArea)) || areas[0];
  let soon = adding ? adding.soon !== false : true;
  const open = (a, s) => {
    const moving = !!editing && !editing.id && isQueueFile(editing.path);
    // a new object right away: a save pending from the text box's blur (iOS) leaves this note alone
    const e = moving ? (editing = { ...editing, soon: s }) : null;
    queueTarget(a.key, s).then(t => {
      if (moving ? editing !== e : editing) return;
      // the open note goes to the new place with its text; or a new note
      editing = moving ? { ...e, path: t.path, index: t.index } : { path: t.path, section: QUEUE_SECTION, id: null, index: t.index, text: '', soon: s };
      saveDraft(); render(); focusEditor();
    }, handleErr);
  };
  const pick = a => { quickArea = a.key; store.set('wd.quickArea', a.key); if (adding) open(a, soon); else render(); };
  const keep = (label, on, fn, title) => h('button', { type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), title,
    onmousedown: ev => ev.preventDefault(), onclick: fn }, label);
  const add = s => btn(s ? '+ Soon' : '+ To the end', () => { autoSave(); open(area, s); }, 'add',
    s ? 'After the first ' + queueSettings(engine.state()).soonAfter + ' cards of the ' + area.name + ' queue' : 'At the end of the ' + area.name + ' queue');
  return h('section', { class: 'sec quick-queue keep-edit' },
    h('h2', { text: 'Add to a queue' }),
    h('div', { class: 'seg' }, areas.map(a => keep(a.name, a === area, () => pick(a)))),
    adding ? [
      h('div', { class: 'seg' }, keep('Soon', soon, () => open(area, true), 'After the first cards of the queue'), keep('At the end', !soon, () => open(area, false))),
      h('p', { class: 'note', text: area.name + ' queue, file ' + queueNumber(adding.path) + (adding.index < 1e9 ? ', card ' + (adding.index + 1) : ', at the end') + '.' }), manyHint(),
      renderEditor()]
    : h('div', { class: 'row queue-add' }, add(true), add(false)));
}
function renderQueue(area) {
  // a file just emptied is deleted on the next flush: not shown meanwhile
  const key = area.key, paths = queuePaths(key).filter(p => !engine.isLoaded(p) || queueCount(p) > 0), set = queueSettings(engine.state());
  const adding = editing && !editing.id && isQueueFile(editing.path) && editing.path.split('/')[1] === key;
  const addBtn = soon => btn(soon ? '+ Add soon' : '+ Add to the end', () => {
    autoSave();
    queueTarget(key, soon).then(t => startEdit(t.path, QUEUE_SECTION, null, t.index), handleErr);
  }, 'add', soon ? 'After the first ' + set.soonAfter + ' cards of the queue' : 'At the end of the queue');
  const out = [h('p', { class: 'date', text: 'Notes waiting to become cards, front first. ↑ Prepared puts one at the end of Prepared.' })];
  if (adding) out.push(h('p', { class: 'note', text: 'New card: file ' + queueNumber(editing.path) + (editing.index < 1e9 ? ', card ' + (editing.index + 1) : ', at the end') + '.' }), manyHint(), renderEditor());
  else out.push(h('div', { class: 'row queue-add' }, addBtn(true), addBtn(false)));
  if (!paths.length) { out.push(h('p', { class: 'empty', text: 'The ' + area.name + ' queue is empty.' })); return out; }
  let p = queueAt[key];
  if (!paths.includes(p)) p = queueAt[key] = paths[0];
  const at = paths.indexOf(p), loaded = engine.isLoaded(p);
  const go = d => { queueAt[key] = paths[at + d]; menuFor = null; render(); };
  const doc = engine.doc(p);
  const items = doc.sections.flatMap(sec => sec.cards.map((card, i) => ({ card, sec, i })));
  out.push(h('div', { class: 'bar queue-bar' },
    h('button', { type: 'button', class: 'icon', title: 'Previous file', 'aria-label': 'Previous file', disabled: at === 0, onclick: () => go(-1) }, '‹'),
    h('span', { class: 'note', text: 'File ' + (at + 1) + ' of ' + paths.length + (loaded ? ' · ' + plural(items.length, 'card') : '') }),
    h('button', { type: 'button', class: 'icon', title: 'Next file', 'aria-label': 'Next file', disabled: at === paths.length - 1, onclick: () => go(1) }, '›')));
  if (!loaded) {
    if (queueFailed.has(p)) out.push(h('p', { class: 'empty' }, 'Couldn’t load this file. ', btn('Try again', () => { queueFailed.delete(p); render(); }, 'link')));
    else { out.push(h('p', { class: 'empty', text: 'Loading…' })); loadQueueFile(p); }
    return out;
  }
  out.push(h('section', { class: 'sec queue' }, items.map(({ card, sec, i }) => {
    const ids = sec.cards.map(c => c.id), more = menuFor === card.id;
    const swap = j => { const n = ids.slice(); [n[i], n[j]] = [n[j], n[i]]; commit(orderOp(p, sec.name, n)); };
    const run = plan => commit(plan.ops, plan.message, plan.undo);
    const actions = [
      btn('↑ Prepared', ev => leave(ev, () => run(queueToPreparedPlan(p, area.name, card, i))), 'primary', 'To the end of Prepared ' + area.name),
      btn('⋯', () => { menuFor = more ? null : card.id; render(); }, 'icon' + (more ? ' on' : ''), 'More actions')];
    if (more) actions.push(h('span', { class: 'more' },
      h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => swap(i - 1) }, '↑'),
      h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === sec.cards.length - 1, onclick: () => swap(i + 1) }, '↓'),
      mergeButton(p, sec.name, card, sec.cards[i + 1], i + 1),
      btn('To the end of the queue', ev => leave(ev, () => {
        menuFor = null;
        return queueTarget(key, false).then(t => run(queueToEndPlan(engine.doc(p), p, card, i, t)), e => { handleErr(e); render(); });
      })),
      btn('Delete', ev => leave(ev, () => { menuFor = null; commit(deleteOp(p, card.id), 'Card deleted.', restoreOp(p, sec.name, card, i)); }), 'danger')));
    return cardView(card, { path: p, section: sec.name, actions });
  })));
  if (at < paths.length - 1 && items.length > 3) out.push(btn('Next file ›', () => { go(1); window.scrollTo(0, 0); }, 'add'));
  return out;
}
// Settings → Queue: cards per file and the "soon" place (state.json "queue")
function queueSettingsView() {
  const q = queueSettings(engine.state());
  const save = (k, raw) => {
    const old = engine.state().queue, v = queueSettings({ queue: { ...q, [k]: parseInt(raw, 10) } })[k];
    if (v === q[k]) { render(); return; }
    commit(stateOp('queue', { ...(old && typeof old === 'object' ? old : {}), [k]: v }),
      k === 'fileSize' ? 'Queue: ' + v + ' cards per file.' : 'Add soon: after ' + v + ' cards.', stateOp('queue', old ?? null));
  };
  const num = (k, label) => h('label', { class: 'setting' }, h('span', { text: label }),
    h('input', { type: 'number', min: '5', max: '500', inputmode: 'numeric', value: String(q[k]), 'aria-label': label, onchange: ev => save(k, ev.target.value) }));
  return h('section', { class: 'sec' }, h('h2', { text: 'Queue' }),
    h('p', { class: 'note', text: 'Notes waiting to be prepared (Preparation → Queue), kept in files of up to this many cards. A new file starts at the end of the queue when the last one is full; an empty file is deleted.' }),
    num('fileSize', 'Cards per file'),
    num('soonAfter', 'Add soon after … cards'),
    h('p', { class: 'note', text: 'Add soon and ✗ Forgot (in the weekly check) put a card after this many cards from the front of the queue, so it comes up again soon. Saved in Dropbox, so all your devices use these.' }));
}
function openPrepArea(name) {
  prepArea = name; store.set('wd.prepArea', name); menuFor = null;
  render();
}
// Cards remembered on this weekday in earlier weeks, waiting for today's check
const dueToday = date => allCards(engine.doc(weekday(date).file)).filter(c => isDue(c, date)).length;
function reminder(date) {
  const due = dueToday(date);
  if (!due) return null;
  return h('div', { class: 'reminder' },
    h('span', { text: 'Weekly check for ' + weekday(date).name + ': ' + plural(due, 'card') + ' to check.' }),
    btn('Open weekly check', () => { checkDay = null; setTab('check'); }, 'primary'));
}

/* ============ Weekly check ============ */
// The box under a collapsed card: what you remember (this browser only). Ctrl+Enter shows the answer;
// ↓ / ↑ on the last / first line go to the next / previous card's box.
function checkBox(card, reveal) {
  const t = h('textarea', { rows: 1, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off',
    placeholder: 'Type what you remember', 'aria-label': 'What you remember' });
  t.value = typedFor(card.id);
  const grow = () => fitHeight(t);
  t.addEventListener('input', () => { setTypedFor(card.id, t.value); grow(); });
  t.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); reveal(); return; }
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const down = ev.key === 'ArrowDown';
      const edge = down ? !t.value.slice(t.selectionEnd).includes('\n') : !t.value.slice(0, t.selectionStart).includes('\n');
      if (!edge) return;
      ev.preventDefault();
      const boxes = [...document.querySelectorAll('.check-typed textarea')], to = boxes[boxes.indexOf(t) + (down ? 1 : -1)];
      if (to) { to.focus(); to.setSelectionRange(to.value.length, to.value.length); }
    }
  });
  t.addEventListener('blur', () => { if (renderPending) setTimeout(() => { if (renderPending && !typingFocused()) render(); }, 0); });
  requestAnimationFrame(grow);
  return t;
}
const checkedDay = () => checkDay ? WEEKDAYS[checkDay - 1] : weekday(today());
// Sections of a weekday file with only the cards due on date
const dueSections = (day, date) => sectionsOf(engine.doc(day.file)).map(sec => ({ name: sec.name, cards: sec.cards.filter(c => isDue(c, date)) }));
function renderCheck() {
  const date = today(), todayDay = weekday(date);
  const day = checkedDay();
  const doc = engine.doc(day.file);
  const select = h('select', { 'aria-label': 'Day', onchange: ev => { checkDay = +ev.target.value === todayDay.n ? null : +ev.target.value; render(); } },
    WEEKDAYS.map(d => h('option', { value: d.n, selected: d.n === day.n }, d.name + (d.n === todayDay.n ? ' (today)' : ''))));
  const out = [h('div', { class: 'bar' }, h('label', { text: 'Cards remembered on' }), select)];
  const dueSecs = dueSections(day, date).filter(s => s.cards.length);
  const shown = dueSecs.reduce((n, s) => n + s.cards.length, 0);
  const later = allCards(doc).length - shown;
  for (const { name, cards: due } of dueSecs) {
    const sec = sectionsOf(doc).find(s => s.name === name);
    out.push(h('section', { class: 'sec' },
      h('h2', {}, sec.name, h('span', { class: 'count', text: String(due.length) })),
      due.map(card => {
        const i = sec.cards.indexOf(card);
        // Collapsed first: only the first line, so the answer can't be peeked at, and a box to type what you remember
        if (!revealed.has(card.id) && !(editing && editing.id === card.id)) {
          const reveal = () => { revealed.add(card.id); render(); };
          const line = h('div', { class: 'md' });
          line.append(toDom(firstLine(card.body)));
          line.addEventListener('click', reveal);
          return h('article', { class: 'card collapsed', 'data-id': card.id }, line,
            h('div', { class: 'typed check-typed' }, checkBox(card, reveal)),
            h('div', { class: 'actions' }, btn('Show answer', reveal, 'primary', 'Show answer (Ctrl+Enter in the box)')));
        }
        return cardView(card, {
          path: day.file, section: sec.name, typed: typedFor(card.id).trim(),
          meta: card.meta.moved ? 'Remembered ' + shortDate(card.meta.moved) : null,
          actions: [
            btn('✓ Still know', ev => leave(ev, () => {
              const op = archiveOp(day.file, sec.name, card, date, sectionKey(sec.name, sectionsList(engine.state())));
              commit(op, 'Archived.', moveOp(op.to, day.file, sec.name, card, {}, i));
            }), 'primary'),
            btn('✗ Forgot', ev => {
              // Back into its area's queue, after the first cards (soon); a heading that isn't an area: removed, text copied
              const area = sectionsList(engine.state()).find(a => a.name === sec.name);
              if (!area) {
                if (navigator.clipboard) navigator.clipboard.writeText(card.body).catch(() => {});   // inside the tap (iOS)
                leave(ev, () => commit(deleteOp(day.file, card.id), 'Removed. The text is copied.', restoreOp(day.file, sec.name, card, i)));
                return;
              }
              leave(ev, () => queueTarget(area.key, true).then(t => {
                const plan = forgotPlan(day.file, sec.name, card, i, t, date);
                commit(plan.ops, plan.message, plan.undo);
              }, e => { handleErr(e); render(); }));
            }, null, 'Back into the queue, to come up again soon'),
            btn('⋯', () => { menuFor = menuFor === card.id ? null : card.id; render(); }, 'icon' + (menuFor === card.id ? ' on' : ''), 'More actions'),
            menuFor === card.id ? h('span', { class: 'more' }, sectionPicker(day.file, sec.name, card, i),
              (n => mergeButton(day.file, sec.name, card, n, sec.cards.indexOf(n)))(due[due.indexOf(card) + 1])) : null
          ].filter(Boolean)
        });
      })));
  }
  if (!shown) out.push(h('p', { class: 'empty', text: 'Nothing to check for ' + day.name + '.' }));
  else out.splice(1, 0, h('p', { class: 'note', text: 'Type what you remember under a card, then tap Show answer to compare it side by side. What you type stays on this device, for today.' }));
  if (later) {
    out.push(h('p', { class: 'note' }, plural(later, 'card') + ' remembered today — they come up next ' + day.name + '. ',
      btn(showLater ? 'Hide' : 'Show', () => { showLater = !showLater; render(); }, 'link')));
    // Remembered by mistake? Bring a card back to Today
    if (showLater) for (const sec of sectionsOf(doc)) {
      const notDue = sec.cards.filter(c => !isDue(c, date));
      if (!notDue.length) continue;
      out.push(h('section', { class: 'sec later' },
        h('h2', {}, sec.name, h('span', { class: 'count', text: String(notDue.length) })),
        notDue.map(card => {
          const i = sec.cards.indexOf(card);
          return cardView(card, { path: day.file, section: sec.name, meta: 'Remembered today',
            actions: [btn('← Back to Today', ev => leave(ev, () =>
              commit(backToTodayOp(day.file, sec.name, card), 'Back in Today.', moveOp(CURRENT, day.file, sec.name, card, {}, i)), 'left'))] });
        })));
    }
  }
  return out;
}

/* ============ Archive ============ */
function renderArchive() {
  // Active areas first, then removed ones and other folders that have an archive
  const areas = sectionsList(engine.state()), stored = engine.paths('archive/').map(p => p.split('/')[1]);
  const keys = areas.filter(s => !s.removed).map(s => s.key).concat(areas.filter(s => s.removed).map(s => s.key).filter(k => stored.includes(k)), stored)
    .filter((k, i, a) => a.indexOf(k) === i);
  if (!keys.includes(archiveKey)) archiveKey = keys[0];
  const nameOf = k => (areas.find(s => s.key === k) || { name: k }).name;
  const months = engine.paths('archive/' + archiveKey + '/').map(p => p.split('/')[2].replace(/\.md$/, '')).sort().reverse();
  if (!months.includes(archiveMonth)) archiveMonth = months[0] || null;
  const out = [h('div', { class: 'chips' }, keys.map(k => btn(nameOf(k), () => { archiveKey = k; archiveMonth = null; render(); }, k === archiveKey ? 'chip on' : 'chip')))];
  if (!archiveMonth) { out.push(h('p', { class: 'empty', text: 'No archived ' + nameOf(archiveKey) + ' cards yet.' })); return out; }
  const path = 'archive/' + archiveKey + '/' + archiveMonth + '.md';
  const search = h('input', { type: 'search', placeholder: 'Search this month', value: archiveQuery, 'aria-label': 'Search',
    oninput: ev => { archiveQuery = ev.target.value; renderList(); } });
  const monthSel = h('select', { 'aria-label': 'Month', onchange: ev => { archiveMonth = ev.target.value; render(); } },
    months.map(m => h('option', { value: m, selected: m === archiveMonth }, monthLabel(m))));
  const list = h('div', {});
  const renderList = () => {
    if (!engine.isLoaded(path)) {
      list.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
      engine.load(path).then(() => renderList(), handleErr);
      return;
    }
    const q = archiveQuery.trim().toLowerCase();
    const cards = allCards(engine.doc(path)).filter(c => !q || plainText(c.body).toLowerCase().includes(q));
    list.replaceChildren(
      h('p', { class: 'note', text: plural(cards.length, 'card') }),
      ...cards.slice().reverse().map(c => cardView(c, { path, section: nameOf(archiveKey), editable: false,
        meta: c.meta.archived ? 'Archived ' + shortDate(c.meta.archived) : null })));
  };
  renderList();
  out.push(h('div', { class: 'bar' }, monthSel, search), list);
  return out;
}

/* ============ Settings ============ */
function renderSettings() {
  const n = engine.pending();
  return [
    areasSettings(),
    queueSettingsView(),
    captureSettings(),
    timerSettingsView(),
    promptSettings(),
    h('section', { class: 'sec' }, h('h2', { text: 'Dropbox' }),
      h('p', { text: 'Cards are Markdown files in Dropbox → Apps → WordDrill.' }),
      h('p', { class: 'note', text: n ? plural(n, 'change') + ' not saved to Dropbox yet.' : 'Everything is saved to Dropbox.' }),
      h('div', { class: 'row' }, btn('Sync now', sync, 'primary'),
        btn('Disconnect', () => {
          if (n && !confirm(plural(n, 'change') + ' are not in Dropbox yet and will stay on this device until you connect again. Disconnect?')) return;
          dbx.disconnect(); show('login');
        }))),
    h('p', { class: 'note', text: 'WordDrill version ' + APP_VERSION })
  ];
}

// Areas (sections): name, cards per day, order; add, rename, remove (state.json "sections" and "targets")
const AREA_PATHS = [CURRENT, PREPARED, ...WEEK_FILES];
function applyPlan(p, after) {
  if (!p || p.error === null) return;
  if (p.error) { toast(p.error, { error: true }); render(); return; }
  if (after) after();
  commit(p.ops, p.message, p.undo);
}
function areasSettings() {
  const state = engine.state(), targets = targetsOf(state);
  const active = activeSections(state), removed = sectionsList(state).filter(s => s.removed);
  const docs = () => AREA_PATHS.map(p => engine.doc(p));
  const rename = (area, value) => applyPlan(renameSectionPlan(engine.state(), area.key, value, AREA_PATHS, docs()), () => {
    // a card being added in that area goes under the new heading
    if (editing && editing.section === area.name) { editing.section = value.replace(/\s+/g, ' ').trim(); saveDraft(); }
  });
  const rows = active.map((area, i) => h('div', { class: 'area' },
    h('input', { type: 'text', class: 'area-name', value: area.name, maxlength: '60', 'aria-label': 'Name of ' + area.name, spellcheck: 'false',
      onchange: ev => rename(area, ev.target.value),
      onkeydown: ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } else if (ev.key === 'Escape') { ev.target.value = area.name; ev.target.blur(); } } }),
    h('select', { 'aria-label': area.name + ' cards per day', title: 'Cards per day',
      onchange: ev => commit(stateOp('targets', { ...(engine.state().targets || {}), [area.name]: +ev.target.value })) },
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => h('option', { value: v, selected: v === targets[area.name] }, String(v)))),
    h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move ' + area.name + ' up', disabled: i === 0,
      onclick: () => applyPlan(moveSectionPlan(engine.state(), area.key, -1)) }, '↑'),
    h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move ' + area.name + ' down', disabled: i === active.length - 1,
      onclick: () => applyPlan(moveSectionPlan(engine.state(), area.key, 1)) }, '↓'),
    h('button', { type: 'button', class: 'icon danger', title: 'Remove ' + area.name, 'aria-label': 'Remove ' + area.name, disabled: active.length < 2,
      onclick: () => {
        const p = removeSectionPlan(engine.state(), area.key, docs(), today(), queuePaths(area.key).length);
        if (p.error || confirm('Remove the area ' + area.name + '? Its archive stays, and adding an area with the same name brings it back.')) applyPlan(p);
      } }, '✕')));
  const name = h('input', { type: 'text', class: 'area-name', maxlength: '60', placeholder: 'New area, e.g. Idioms', 'aria-label': 'New area name',
    onkeydown: ev => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } } });
  const add = () => applyPlan(addSectionPlan(engine.state(), name.value, engine.paths('archive/').map(p => p.split('/')[1])));
  return h('section', { class: 'sec' }, h('h2', { text: 'Areas and cards per day' }),
    h('p', { class: 'note', text: 'The number is how many cards an area keeps in Today: ✓ (Remembered) tops it up from Preparation, and Preparation warns when it holds less. Renaming changes the headings in your files; the archive stays where it is. An area can be removed once it has no cards in Today, Preparation or the weekly check; its archive stays.' }),
    h('div', { class: 'areas' }, rows),
    h('div', { class: 'area add-area' }, name, btn('+ Add area', add)),
    removed.length ? h('p', { class: 'note' }, 'Removed: ',
      removed.map((s, i) => [i ? ', ' : '', s.name + ' ', btn('Bring back', () => applyPlan(addSectionPlan(engine.state(), s.name)), 'link')])) : null);
}

// state.json "timer": other keys there are kept
function saveTimerSettings(patch, message) {
  const old = engine.state().timer;
  commit(stateOp('timer', { ...(old && typeof old === 'object' ? old : {}), ...patch }), message, stateOp('timer', old ?? null));
}
// The keyboard shortcuts (state.json): kind 'timer' (start / pause) or 'copy' (Copy for AI check)
const SHORTCUTS = {
  timer: { name: 'Timer start / pause', current: () => timerSettings(engine.state()).shortcut, def: DEFAULT_SHORTCUT,
    save: (sc, msg) => saveTimerSettings({ shortcut: sc }, msg) },
  copy: { name: 'Copy for AI check', current: () => copyShortcutOf(engine.state()), def: DEFAULT_COPY_SHORTCUT,
    save: (sc, msg) => commit(stateOp('aiShortcut', sc), msg, stateOp('aiShortcut', engine.state().aiShortcut ?? null)) }
};
// One shortcut row: the keys, Change (records the next key press), Turn off, Default
function shortcutSetting(kind) {
  const k = SHORTCUTS[kind], sc = k.current();
  return h('div', { class: 'setting' }, h('span', { text: k.name + ' shortcut' }),
    recordingShortcut === kind
      ? [h('strong', { text: 'Press the new keys…' }), btn('Cancel', () => { recordingShortcut = null; render(); }, 'link')]
      : [h('kbd', { text: shortcutLabel(sc) }),
        btn('Change', () => { recordingShortcut = kind; render(); }),
        sc ? btn('Turn off', () => k.save('', k.name + ' shortcut turned off.'), 'link') : null,
        sc !== k.def ? btn('Default (' + shortcutLabel(k.def) + ')', () => k.save(k.def, k.name + ': ' + shortcutLabel(k.def) + '.'), 'link') : null]);
}
const SHORTCUT_NOTE = 'For the keyboard on a computer. Hold Ctrl, Alt or Win/Cmd with a key, or use an F key. Browser shortcuts such as Ctrl+T or Ctrl+W can’t be used. Saved in Dropbox, so all your devices use these.';
function timerSettingsView() {
  const t = timerSettings(engine.state());
  const cycles = h('input', { type: 'number', min: '1', max: '999', inputmode: 'numeric', value: String(t.cycles), 'aria-label': 'Cycles by default',
    onchange: ev => saveTimerSettings({ cycles: clampTotal(ev.target.value) }, 'Timer: ' + clampTotal(ev.target.value) + ' cycles by default.') });
  return h('section', { class: 'sec' }, h('h2', { text: 'Timer' }),
    h('p', { class: 'note', text: 'Cycles of 10 seconds. The timer starts with this number after Reset or when it finishes; the timer panel can change it for one run.' }),
    h('label', { class: 'setting' }, h('span', { text: 'Cycles by default' }), cycles),
    shortcutSetting('timer'),
    h('p', { class: 'note', text: SHORTCUT_NOTE }));
}
function promptSettings() {
  const saved = engine.state().aiPrompt ?? null;
  const t = h('textarea', { class: 'prompt', rows: 12, spellcheck: 'true', 'aria-label': 'AI check prompt' });
  t.value = promptOf(engine.state());
  const save = value => commit(stateOp('aiPrompt', value), value == null ? 'Prompt reset to the default.' : 'Prompt saved.', stateOp('aiPrompt', saved));
  return h('section', { class: 'sec' }, h('h2', { text: 'AI check prompt' }),
    shortcutSetting('copy'),
    h('p', { class: 'note', text: 'Copy for AI check on Today copies this text. {typed} is replaced with the cards you typed from memory and {cards} with today’s cards; without them both lists go at the end. Saved in Dropbox, so all your devices use it.' }),
    t,
    h('div', { class: 'row' },
      btn('Save prompt', () => {
        const v = t.value.trim();
        save(!v || v === DEFAULT_CHECK_PROMPT.trim() ? null : t.value);
      }, 'primary'),
      saved != null ? btn('Reset to default', () => { if (confirm('Replace your prompt with the default one?')) save(null); }) : null));
}

/* ============ Rendering ============ */
function setTab(t) {
  autoSave();
  // Filling Prepared or doing the weekly check, then back to type today's cards: Today is hidden again
  if (t === 'prepared' || t === 'check') hideList('today');
  tab = t; store.set('wd.tab', t); menuFor = null; recordingShortcut = null;
  render();
  window.scrollTo(0, 0);
}
// Changes from another device must not rebuild the page under the user's fingers while they type
function backgroundRender() {
  if (typingFocused()) { renderPending = true; return; }
  render();
}
function render() {
  renderPending = false;
  const animate = animateNext && !reducedMotion();
  animateNext = false;
  const before = animate ? cardRects() : null;
  if (CAPTURE) { if (!engine) return; $('#view').replaceChildren(...captureView().filter(Boolean)); return; }
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const view = { today: () => renderList(CURRENT), prepared: () => renderList(PREPARED), check: renderCheck, archive: renderArchive, settings: renderSettings }[tab] || (() => renderList(CURRENT));
  $('#view').replaceChildren(...[view()].flat().filter(Boolean));
  if (animate) playMoves(before);
  if (timer) timer.refresh();   // timer settings may have changed (here or synced)
  if (focusRecall) {
    const t = document.querySelector('.recall textarea[data-rid="' + focusRecall + '"]');
    focusRecall = null;
    if (t) { t.focus(); t.scrollIntoView({ block: 'nearest' }); }
  }
  // Red dots: cards to check today / Prepared low. Blinking tab: a section of Prepared is empty.
  $('#checkBadge').hidden = !dueToday(today());
  const short = preparedShortage(engine.doc(PREPARED), targetsOf(engine.state()));
  $('#preparedBadge').hidden = !short.length;
  $('[data-tab=prepared]').classList.toggle('blink', short.some(x => x.have === 0));
}

/* ============ Start ============ */
function wire() {
  if (!CAPTURE) timer = mountTimer({ button: $('#timerBtn'), panel: $('#timerPanel'), store, settings: () => timerSettings(engine.state()) });
  // Settings → Timer → Change: the next key combination becomes the shortcut (before any other key handling)
  window.addEventListener('keydown', ev => {
    if (!recordingShortcut) return;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.key === 'Escape') { recordingShortcut = null; render(); return; }
    const sc = shortcutOf(ev);
    if (sc === null) return;   // only a modifier so far
    if (!sc) { toast('Hold Ctrl, Alt or Win/Cmd with the key, or use an F key.'); return; }
    const kind = recordingShortcut, other = Object.keys(SHORTCUTS).find(o => o !== kind && SHORTCUTS[o].current() === sc);
    if (other) { toast(shortcutLabel(sc) + ' is already the ' + SHORTCUTS[other].name + ' shortcut.'); return; }
    recordingShortcut = null;
    SHORTCUTS[kind].save(sc, SHORTCUTS[kind].name + ': ' + shortcutLabel(sc) + '.');
  }, true);
  // Copy for AI check from the keyboard: Today's lists, from any tab
  document.addEventListener('keydown', ev => {
    if (CAPTURE || !matchesShortcut(ev, copyShortcutOf(engine.state()))) return;
    ev.preventDefault();
    copyCheck('today');
  });
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#loginRedirect').addEventListener('click', () => dbx.startLogin(true).catch(handleErr));
  $('#loginCode').addEventListener('click', () => dbx.startLogin(false).catch(handleErr));
  $('#codeSubmit').addEventListener('click', async () => {
    try { await dbx.exchange($('#codeInput').value); start(); } catch (e) { toast(e.message, { error: true }); }
  });
  if (navigator.standalone) $('#codeBox').open = true;
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Back after a long break (say, from morning to midday): Today's list is hidden again for recall
      if (hiddenAt && Date.now() - hiddenAt > LIST_HIDE_AFTER) hideList('today');
      backgroundRender(); sync();
    } else { hiddenAt = Date.now(); autoSave(); flush(); }
  });
  // A click anywhere outside the open editor saves it first; the click then does what it was for
  // (its handlers still run, even though the page was redrawn).
  document.addEventListener('click', ev => {
    if (!ev.isTrusted) return;   // not a real tap (a script click)
    if (editing && !(ev.target.closest && ev.target.closest('.editor, .keep-edit button'))) autoSave();
  }, true);
  window.addEventListener('online', sync);
  window.addEventListener('offline', () => updateStatus());
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); backgroundRender(); } }, 60000);
}
function start() {
  if (editingIn('today')) setListShown('today', true);   // a card was being edited: keep the list open
  show('app');
  render();
  if (editing) focusEditor();
  sync();
}
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  wire();
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    try { await dbx.exchange(code); } catch (e) { toast(e.message, { error: true }); }
    history.replaceState(null, '', REDIRECT_URI);
  }
  if (CAPTURE) { startCapture(); return; }
  if (dbx.connected()) start(); else show('login');
})();
