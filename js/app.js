// UI: Today (current cards), Prepared (next cards), Weekly check, Archive, Settings. All changes go through the sync engine
// as ops (see js/ops.js, js/sync.js); the UI never writes files itself.

import { createDropbox, AuthError, REDIRECT_URI } from './dropbox.js';
import { createEngine } from './sync.js';
import { createDemoDropbox } from './demo.js';
import { allCards, normalizeBody } from './format.js';
import { today, weekday, WEEKDAYS, WEEK_FILES, isDue, monthLabel } from './dates.js';
import {
  SECTIONS, CURRENT, STATE, PREPARED, addOp, editOp, deleteOp, restoreOp, orderOp, archiveOp, moveOp, stateOp,
  findCard, targetsOf, rememberPlan, toTodayOp, toPreparedOp, preparedShortage, backToTodayOp, sectionOp
} from './ops.js';
import { createVersions } from './versions.js';
import { mountTimer } from './timer-ui.js';
import { timerSettings, clampTotal, shortcutOf, shortcutLabel, matchesShortcut, DEFAULT_SHORTCUT } from './timer.js';
import { DEFAULT_CHECK_PROMPT, promptOf, recallFor, typedTexts, buildCheckText, copyShortcutOf, DEFAULT_COPY_SHORTCUT, checkTypedFor } from './recall.js';
import { toDom, plainText, toggleWrap, toggleLinePrefix, toggleFence, firstLine, insertTable } from './markdown.js';

const APP_VERSION = '21';   // shown in Settings; keep in step with CACHE in sw.js
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
const engine = createEngine({ api: dbx.api, storage: store, key: DEMO ? 'demo.data' : 'wd.data' });

/* ============ UI state ============ */
let tab = store.get('wd.tab') || 'today';
let checkDay = null;                        // weekday number picked in Weekly check; null = today
let archiveKey = SECTIONS[0].key, archiveMonth = null, archiveQuery = '';
let editing = store.get('wd.draft');        // { path, section, id|null, index?, text } — survives reloads
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
  if (!dbx.connected() || !engine.pending()) return updateStatus();
  if (!navigator.onLine) return updateStatus();
  updateStatus('Saving…');
  try { await engine.flush(); updateStatus(); } catch (e) { handleErr(e); }
}
async function sync() {
  if (!dbx.connected()) return;
  if (!navigator.onLine) return updateStatus();
  updateStatus('Syncing…');
  try {
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
function saveDraft() { if (editing) store.set('wd.draft', editing); else store.del('wd.draft'); }
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
  if (!e.id) { closeEditor(); commit(addOp(e.path, e.section, text, today())); return; }
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
  const grow = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
  const set = r => { t.value = r.value; t.setSelectionRange(r.start, r.end); e.text = t.value; saveDraft(); grow(); };
  const wrap = m => set(toggleWrap(t.value, t.selectionStart, t.selectionEnd, m));
  const prefix = p => set(toggleLinePrefix(t.value, t.selectionStart, t.selectionEnd, p));
  t.addEventListener('input', () => { e.text = t.value; saveDraft(); grow(); });
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
  // Toolbar buttons keep the focus (and the selection) in the text box
  const tool = (label, title, fn, cls) => h('button', { type: 'button', class: 'tool ' + (cls || ''), title, 'aria-label': title,
    onmousedown: ev => ev.preventDefault(), onclick: () => { fn(); t.focus(); } }, label);
  const keep = (label, fn, cls) => h('button', { type: 'button', class: cls, onmousedown: ev => ev.preventDefault(), onclick: fn }, label);
  // Earlier texts of this card from this session; picking one puts it in the text box
  const earlier = e.id ? versions.list(e.id) : [];
  const list = h('div', { class: 'versions', hidden: true },
    h('p', { class: 'note', text: 'Earlier texts of this card from this session. Tap one to put it back in the box.' }),
    earlier.map(v => keep([h('span', { class: 'when', text: new Date(v.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }),
      h('span', { class: 'what', text: plainText(v.text).split('\n').join(' · ') })], () => {
      versions.add(e.id, e.text);
      t.value = v.text; e.text = v.text; saveDraft(); grow(); t.focus();
    }, 'version')));
  return h('div', { class: 'editor' },
    h('div', { class: 'toolbar' },
      tool('B', 'Bold (Ctrl+B)', () => wrap('**'), 'b'), tool('I', 'Italic (Ctrl+I)', () => wrap('*'), 'i'),
      tool('U', 'Underline (Ctrl+U): ~text~', () => wrap('~'), 'u'),
      tool('❝', 'Quote', () => prefix('> ')), tool('•', 'List', () => prefix('- ')), tool('1.', 'Numbered list', () => prefix('1. ')),
      tool('{ }', 'Box, e.g. for etymology', () => set(toggleFence(t.value, t.selectionStart, t.selectionEnd)), 'box'),
      tool('⊞', 'Table', () => set(insertTable(t.value, t.selectionStart, t.selectionEnd)), 'table'),
      earlier.length ? tool('↺ ' + earlier.length, 'Earlier versions', () => { list.hidden = !list.hidden; }, 'hist') : null),
    t,
    list,
    h('div', { class: 'row' }, keep('Save', saveEdit, 'primary'), keep('Cancel', cancelEdit)));
}
function cancelEdit() {
  const e = editing;
  const f = e.id && findCard(engine.doc(e.path), e.id);
  const original = e.id ? (f ? f.card.body : '') : '';
  if (normalizeBody(e.text) !== normalizeBody(original) && !confirm('Discard your changes to this card?')) return;
  closeEditor();
}
const editorFocused = () => !!document.activeElement && document.activeElement.matches('.editor textarea');
const typingFocused = () => !!document.activeElement && document.activeElement.matches('.editor textarea, .typed textarea, textarea.prompt');

/* ============ Cards ============ */
// "Move to…" another section of the same file; Undo puts the card back in its place
function sectionPicker(path, section, card, index) {
  const others = SECTIONS.map(x => x.name).filter(n => n !== section);
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
const sectionsOf = doc => {
  const names = SECTIONS.map(s => s.name);
  const extra = doc.sections.map(s => s.name).filter(n => !names.includes(n));
  return names.concat(extra).map(name => ({ name, cards: (doc.sections.find(s => s.name === name) || { cards: [] }).cards }));
};

/* ============ Today and Prepared ============ */
// Both tabs show the same three sections; path is CURRENT or PREPARED
function renderList(path) {
  const date = today(), doc = engine.doc(path), isToday = path === CURRENT;
  const targets = targetsOf(engine.state());
  const dateLine = () => h('p', { class: 'date', text: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) });
  if (isToday && !listShown('today')) {
    const counts = sectionsOf(doc).filter(sec => sec.cards.length || targets[sec.name]).map(sec => sec.name + ' ' + sec.cards.length).join(' · ');
    return [dateLine(), recallPanel('today', 'today’s cards'),
      h('p', { class: 'note hidden-list', text: 'Today’s cards are hidden: ' + (counts || 'none') + '.' }),
      reminder(date), preparedReminder()];
  }
  const out = [isToday ? dateLine()
    : h('p', { class: 'date', text: 'Next cards, top first. ✓ (Remembered) in Today brings the top card of the same section into Today.' })];
  if (isToday) out.push(recallBar('today'));
  for (const sec of sectionsOf(doc)) {
    const ids = sec.cards.map(c => c.id);
    const target = targets[sec.name] || 0;
    const cards = sec.cards.map((card, i) => {
      const swap = j => { const n = ids.slice(); [n[i], n[j]] = [n[j], n[i]]; commit(orderOp(path, sec.name, n)); };
      const more = menuFor === card.id;
      const main = isToday
        ? h('button', { type: 'button', class: 'primary remember', title: 'Remembered', 'aria-label': 'Remembered', onclick: ev => leave(ev, () => {
          const plan = rememberPlan(engine.doc(CURRENT), engine.doc(PREPARED), sec.name, card, date, target);
          commit(plan.ops, 'Moved to ' + weekday(date).name + '’s check.' + (plan.refill ? ' Next card added from Prepared.' : ''), plan.undo);
        }) }, '✓')
        : btn('← Today', ev => leave(ev, () => commit(toTodayOp(sec.name, card, date), 'Moved to Today.', moveOp(CURRENT, PREPARED, sec.name, card, {}, i)), 'left'), 'primary');
      const actions = [main, btn('⋯', () => { menuFor = more ? null : card.id; render(); }, 'icon' + (more ? ' on' : ''), 'More actions')];
      if (more) actions.push(h('span', { class: 'more' },
        h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => swap(i - 1) }, '↑'),
        h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === sec.cards.length - 1, onclick: () => swap(i + 1) }, '↓'),
        sectionPicker(path, sec.name, card, i),
        isToday ? btn('Prepared →', ev => leave(ev, () => { menuFor = null; commit(toPreparedOp(sec.name, card), 'Moved back to the top of Prepared.', moveOp(PREPARED, CURRENT, sec.name, card, {}, i)); })) : null,
        btn('Delete', ev => leave(ev, () => { menuFor = null; commit(deleteOp(path, card.id), 'Card deleted.', restoreOp(path, sec.name, card, i)); }), 'danger')));
      return cardView(card, { path, section: sec.name, actions });
    });
    const adding = editing && editing.path === path && !editing.id && editing.section === sec.name;
    const low = !isToday && target > 0 && sec.cards.length < target;
    out.push(h('section', { class: 'sec' },
      h('h2', {}, sec.name,
        h('span', { class: 'count', text: isToday ? sec.cards.length + ' / ' + target : String(sec.cards.length) }),
        low ? h('span', { class: 'low', text: sec.cards.length ? 'less than a day’s ' + target : 'empty' }) : null),
      cards,
      adding ? renderEditor() : btn('+ Add', () => startEdit(path, sec.name, null), 'add')));
  }
  if (isToday) out.push(reminder(date), preparedReminder());
  return out;
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
  const box = (it, i) => {
    // No spellcheck or autocorrect: the point is to see your own spelling
    const t = h('textarea', { rows: 1, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', autocomplete: 'off',
      placeholder: i ? 'Next card' : 'Type a card from memory', 'aria-label': 'Card ' + (i + 1), 'data-rid': it.id });
    t.value = it.text;
    const grow = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
    t.addEventListener('input', () => { it.text = t.value; saveRecall(k); grow(); updateRecallButtons(); });
    t.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); addAfter(it); }
      else if (ev.key === 'Backspace' && !t.value && r.items.length > 1) { ev.preventDefault(); remove(it); }
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
    h('p', { class: 'note', text: 'Type every card you remember, in any order, then show ' + what + '. Ctrl+Enter starts the next card. Kept on this device only, for today.' }),
    r.items.map(box),
    btn('+ Next card', () => addAfter(r.items[r.items.length - 1]), 'add', '+ Next card (Ctrl+Enter)'),
    h('div', { class: 'row' }, showBtn, copyBtn, clearBtn));
}
let updateRecallButtons = () => {};

function preparedReminder() {
  const short = preparedShortage(engine.doc(PREPARED), targetsOf(engine.state()));
  if (!short.length) return null;
  return h('div', { class: 'reminder' },
    h('span', { text: 'Prepared is running low: ' + short.map(x => x.section + ' ' + x.have + ' of ' + x.need).join(', ') + '.' }),
    btn('Open Prepared', () => setTab('prepared'), 'primary'));
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
  const grow = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
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
              const op = archiveOp(day.file, sec.name, card, date);
              commit(op, 'Archived.', moveOp(op.to, day.file, sec.name, card, {}, i));
            }), 'primary'),
            btn('✗ Forgot', ev => {
              // Clipboard first, while still inside the tap (iOS allows it only there)
              if (navigator.clipboard) navigator.clipboard.writeText(card.body).catch(() => {});
              leave(ev, () => commit(deleteOp(day.file, card.id), 'Removed. The text is copied — paste it into TickTick.', restoreOp(day.file, sec.name, card, i)));
            }),
            btn('⋯', () => { menuFor = menuFor === card.id ? null : card.id; render(); }, 'icon' + (menuFor === card.id ? ' on' : ''), 'More actions'),
            menuFor === card.id ? h('span', { class: 'more' }, sectionPicker(day.file, sec.name, card, i)) : null
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
  const keys = SECTIONS.map(s => s.key).concat(engine.paths('archive/').map(p => p.split('/')[1]))
    .filter((k, i, a) => a.indexOf(k) === i);
  const nameOf = k => (SECTIONS.find(s => s.key === k) || { name: k }).name;
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
  const targets = targetsOf(engine.state());
  return [
    h('section', { class: 'sec' }, h('h2', { text: 'Cards per day' }),
      h('p', { class: 'note', text: 'How many cards each section keeps in Today. ✓ (Remembered) tops a section up from Prepared to this number; Prepared warns when it holds less than this.' }),
      h('div', { class: 'targets' }, SECTIONS.map(({ name }) => h('label', {}, h('span', { text: name }),
        h('select', { 'aria-label': name + ' cards per day', onchange: ev => commit(stateOp('targets', { ...targetsOf(engine.state()), [name]: +ev.target.value })) },
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(v => h('option', { value: v, selected: v === targets[name] }, String(v)))))))),
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
  timer = mountTimer({ button: $('#timerBtn'), panel: $('#timerPanel'), store, settings: () => timerSettings(engine.state()) });
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
    if (!matchesShortcut(ev, copyShortcutOf(engine.state()))) return;
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
    if (editing && !(ev.target.closest && ev.target.closest('.editor'))) autoSave();
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
  if (dbx.connected()) start(); else show('login');
})();
