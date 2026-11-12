// UI: Today (current cards), Weekly check, Archive, Settings. All changes go through the sync engine
// as ops (see js/ops.js, js/sync.js); the UI never writes files itself.

import { createDropbox, AuthError, REDIRECT_URI } from './dropbox.js';
import { createEngine } from './sync.js';
import { createDemoDropbox } from './demo.js';
import { allCards, normalizeBody } from './format.js';
import { today, weekday, WEEKDAYS, WEEK_FILES, isDue, monthLabel } from './dates.js';
import {
  SECTIONS, CURRENT, STATE, addOp, editOp, deleteOp, restoreOp, orderOp, rememberOp, archiveOp, moveOp, stateOp,
  findCard, sectionKey
} from './ops.js';
import { toDom, plainText, toggleWrap, toggleLinePrefix } from './markdown.js';

const APP_VERSION = '1';   // shown in Settings; keep in step with CACHE in sw.js
const CORE = [CURRENT, STATE, ...WEEK_FILES];
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
const dbx = DEMO ? createDemoDropbox(store) : createDropbox(store);
const engine = createEngine({ api: dbx.api, storage: store, key: DEMO ? 'demo.data' : 'wd.data' });

/* ============ UI state ============ */
let tab = store.get('wd.tab') || 'today';
let checkDay = null;                        // weekday number picked in Weekly check; null = today
let archiveKey = SECTIONS[0].key, archiveMonth = null, archiveQuery = '';
let editing = store.get('wd.draft');        // { path, section, id|null, index?, text } — survives reloads
let menuFor = null;                         // card id whose extra actions are shown
let renderPending = false;

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
function commit(op, message, undoOp) {
  engine.add(op);
  render();
  scheduleFlush();
  if (message) toast(message, undoOp ? { undo: () => commit(undoOp) } : {});
}

/* ============ Editing ============ */
function saveDraft() { if (editing) store.set('wd.draft', editing); else store.del('wd.draft'); }
function startEdit(path, section, card, index) {
  if (editing) {
    if (editing.id === (card && card.id) && editing.path === path) return;
    toast('Save or cancel the card you’re editing first.');
    focusEditor();
    return;
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
  if (!f || f.card.body !== text) commit(editOp(e.path, e.section, card, text));
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
  });
  t.addEventListener('blur', () => { if (renderPending) setTimeout(() => { if (renderPending && !editorFocused()) render(); }, 0); });
  requestAnimationFrame(grow);
  // Toolbar buttons keep the focus (and the selection) in the text box
  const tool = (label, title, fn, cls) => h('button', { type: 'button', class: 'tool ' + (cls || ''), title, 'aria-label': title,
    onmousedown: ev => ev.preventDefault(), onclick: () => { fn(); t.focus(); } }, label);
  return h('div', { class: 'editor' },
    h('div', { class: 'toolbar' },
      tool('B', 'Bold (Ctrl+B)', () => wrap('**'), 'b'), tool('I', 'Italic (Ctrl+I)', () => wrap('*'), 'i'),
      tool('❝', 'Quote', () => prefix('> ')), tool('•', 'List', () => prefix('- ')), tool('1.', 'Numbered list', () => prefix('1. '))),
    t,
    h('div', { class: 'row' }, btn('Save', saveEdit, 'primary'), btn('Cancel', cancelEdit)));
}
function cancelEdit() {
  const e = editing;
  const f = e.id && findCard(engine.doc(e.path), e.id);
  const original = e.id ? (f ? f.card.body : '') : '';
  if (normalizeBody(e.text) !== normalizeBody(original) && !confirm('Discard your changes to this card?')) return;
  closeEditor();
}
const editorFocused = () => !!document.activeElement && document.activeElement.matches('.editor textarea');

/* ============ Cards ============ */
function cardView(card, { path, section, actions = [], meta, editable = true }) {
  if (editing && editing.path === path && editing.id === card.id) return renderEditor();
  const body = h('div', { class: 'md' + (editable ? ' editable' : '') });
  body.append(toDom(card.body));
  if (editable) body.addEventListener('click', ev => {
    if (String(getSelection())) return;   // selecting text to copy, not editing
    ev.preventDefault();
    startEdit(path, section, card);
  });
  return h('article', { class: 'card' }, body,
    meta ? h('div', { class: 'meta', text: meta }) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}
const sectionsOf = doc => {
  const names = SECTIONS.map(s => s.name);
  const extra = doc.sections.map(s => s.name).filter(n => !names.includes(n));
  return names.concat(extra).map(name => ({ name, cards: (doc.sections.find(s => s.name === name) || { cards: [] }).cards }));
};

/* ============ Today ============ */
function renderToday() {
  const date = today(), doc = engine.doc(CURRENT);
  const out = [h('p', { class: 'date', text: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) })];
  for (const sec of sectionsOf(doc)) {
    const ids = sec.cards.map(c => c.id);
    const cards = sec.cards.map((card, i) => {
      const swap = j => { const n = ids.slice(); [n[i], n[j]] = [n[j], n[i]]; commit(orderOp(CURRENT, sec.name, n)); };
      const more = menuFor === card.id;
      const actions = [
        btn('✓ Remembered', () => commit(rememberOp(sec.name, card, date), 'Moved to ' + weekday(date).name + '’s check.',
          moveOp(weekday(date).file, CURRENT, sec.name, card, {}, i)), 'primary'),
        btn('⋯', () => { menuFor = more ? null : card.id; render(); }, 'icon' + (more ? ' on' : ''), 'More actions')
      ];
      if (more) actions.push(h('span', { class: 'more' },
        btn('↑', () => swap(i - 1), 'icon', 'Move up'), btn('↓', () => swap(i + 1), 'icon', 'Move down'),
        btn('Delete', () => { menuFor = null; commit(deleteOp(CURRENT, card.id), 'Card deleted.', restoreOp(CURRENT, sec.name, card, i)); }, 'danger')));
      if (more && i === 0) actions[2].children[0].disabled = true;
      if (more && i === sec.cards.length - 1) actions[2].children[1].disabled = true;
      return cardView(card, { path: CURRENT, section: sec.name, actions });
    });
    const adding = editing && editing.path === CURRENT && !editing.id && editing.section === sec.name;
    out.push(h('section', { class: 'sec' },
      h('h2', {}, sec.name, h('span', { class: 'count', text: String(sec.cards.length) })),
      cards,
      adding ? renderEditor() : btn('+ Add', () => startEdit(CURRENT, sec.name, null), 'add')));
  }
  out.push(reminder(date));
  return out;
}
function reminder(date) {
  if (engine.state().weekCheckDone === date) return null;
  const day = weekday(date);
  const due = allCards(engine.doc(day.file)).filter(c => isDue(c, date)).length;
  return h('div', { class: 'reminder' },
    h('span', { text: 'Weekly check for ' + day.name + ': ' + (due ? plural(due, 'card') + ' waiting.' : 'nothing to check.') + ' Not marked as done yet.' }),
    btn('Open weekly check', () => { checkDay = null; setTab('check'); }, 'primary'));
}

/* ============ Weekly check ============ */
function renderCheck() {
  const date = today(), todayDay = weekday(date);
  const day = checkDay ? WEEKDAYS[checkDay - 1] : todayDay;
  const doc = engine.doc(day.file);
  const select = h('select', { 'aria-label': 'Day', onchange: ev => { checkDay = +ev.target.value === todayDay.n ? null : +ev.target.value; render(); } },
    WEEKDAYS.map(d => h('option', { value: d.n, selected: d.n === day.n }, d.name + (d.n === todayDay.n ? ' (today)' : ''))));
  const out = [h('div', { class: 'bar' }, h('label', { text: 'Cards remembered on' }), select)];
  let shown = 0, later = 0;
  for (const sec of sectionsOf(doc)) {
    const due = sec.cards.filter(c => isDue(c, date));
    later += sec.cards.length - due.length;
    if (!due.length) continue;
    shown += due.length;
    out.push(h('section', { class: 'sec' },
      h('h2', {}, sec.name, h('span', { class: 'count', text: String(due.length) })),
      due.map(card => {
        const i = sec.cards.indexOf(card);
        return cardView(card, {
          path: day.file, section: sec.name,
          meta: card.meta.moved ? 'Remembered ' + shortDate(card.meta.moved) : null,
          actions: [
            btn('✓ Still know', () => {
              const op = archiveOp(day.file, sec.name, card, date);
              commit(op, 'Archived.', moveOp(op.to, day.file, sec.name, card, {}, i));
            }, 'primary'),
            btn('✗ Forgot', () => {
              if (navigator.clipboard) navigator.clipboard.writeText(card.body).catch(() => {});
              commit(deleteOp(day.file, card.id), 'Removed. The text is copied — paste it into TickTick.', restoreOp(day.file, sec.name, card, i));
            })
          ]
        });
      })));
  }
  if (!shown) out.push(h('p', { class: 'empty', text: 'Nothing to check for ' + day.name + '.' }));
  if (later) out.push(h('p', { class: 'note', text: plural(later, 'card') + ' remembered today — they come up next ' + day.name + '.' }));
  const done = engine.state().weekCheckDone === date;
  out.push(h('div', { class: 'done-box' + (done ? ' done' : '') }, done
    ? [h('span', { text: '✓ Weekly check done today.' }), btn('Undo', () => commit(stateOp('weekCheckDone', null)), 'link')]
    : [h('span', { text: 'Finished checking today’s cards?' }), btn('Mark weekly check done', () => commit(stateOp('weekCheckDone', date), 'Weekly check marked as done.'), 'primary')]));
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
  return [
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

/* ============ Rendering ============ */
function setTab(t) {
  tab = t; store.set('wd.tab', t); menuFor = null;
  render();
  window.scrollTo(0, 0);
}
// Changes from another device must not rebuild the page under the user's fingers while they type
function backgroundRender() {
  if (editorFocused()) { renderPending = true; return; }
  render();
}
function render() {
  renderPending = false;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const view = { today: renderToday, check: renderCheck, archive: renderArchive, settings: renderSettings }[tab] || renderToday;
  $('#view').replaceChildren(...[view()].flat().filter(Boolean));
  const badge = $('#checkBadge');
  const date = today();
  badge.hidden = engine.state().weekCheckDone === date;
}

/* ============ Start ============ */
function wire() {
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#loginRedirect').addEventListener('click', () => dbx.startLogin(true).catch(handleErr));
  $('#loginCode').addEventListener('click', () => dbx.startLogin(false).catch(handleErr));
  $('#codeSubmit').addEventListener('click', async () => {
    try { await dbx.exchange($('#codeInput').value); start(); } catch (e) { toast(e.message, { error: true }); }
  });
  if (navigator.standalone) $('#codeBox').open = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { backgroundRender(); sync(); } else flush(); });
  window.addEventListener('online', sync);
  window.addEventListener('offline', () => updateStatus());
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); backgroundRender(); } }, 60000);
}
function start() {
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
