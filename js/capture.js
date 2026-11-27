// Capture: text highlighted on any page goes to a queue through a bookmarklet. The bookmarklet opens
// WordDrill in a small window with ?add=<text>; that window works like a separate device (its own
// storage keys and engine, see app.js), so it never overwrites the pending changes of an open WordDrill tab.

export const CAPTURE_PARAM = 'add';
export const CAPTURE_MAX = 20000;          // characters; a huge selection is cut (and the window says so)
export const CAPTURE_LOCK = 'worddrill-capture';

/** The text from the window's address: {text, cut} or null when it isn't a capture window */
export function captureText(search) {
  const p = new URLSearchParams(search);
  if (!p.has(CAPTURE_PARAM)) return null;
  let text = String(p.get(CAPTURE_PARAM)).replace(/\r\n?/g, '\n').trim();
  const cut = text.length > CAPTURE_MAX;
  if (cut) text = text.slice(0, CAPTURE_MAX);
  return { text, cut };
}

/** Which kind of page this is: capture (a bookmarklet window, a Shortcut page, or the WD Add app) and app (WD Add) */
export function captureMode(search) {
  const p = new URLSearchParams(search), app = p.get('app') === 'add';
  return { capture: app || p.has(CAPTURE_PARAM), app };
}

/** The capture address without the text: <app>?add= (query and hash dropped; demo keeps ?demo). The iPhone
 * Shortcut appends the URL-encoded text to it. */
export const captureUrl = (appUrl, demo) => appUrl.split(/[?#]/)[0] + (demo ? '?demo&' : '?') + CAPTURE_PARAM + '=';

/**
 * The bookmarklet for the app at appUrl. It sends the selected part of a text box, else the page's selection;
 * when that is empty it looks inside the page's frames, nested too (course players such as SCORM show the
 * lesson in an iframe, whose selection the top page doesn't see). A frame from another site can't be read by
 * any page script, so it is skipped (try/catch).
 */
export function bookmarklet(appUrl, demo) {
  const target = captureUrl(appUrl, demo);
  return 'javascript:(()=>{const f=w=>{try{const a=w.document.activeElement;' +
    'if(a&&/^(TEXTAREA|INPUT)$/.test(a.tagName)&&a.selectionEnd>a.selectionStart)return a.value.slice(a.selectionStart,a.selectionEnd);' +
    'const s=String(w.getSelection());if(s)return s;' +
    'for(let i=0;i<w.frames.length;i++){const t=f(w.frames[i]);if(t)return t}}catch(e){}return""};' +
    'window.open(' + JSON.stringify(target) + '+encodeURIComponent(f(window)),"worddrill-add","popup,width=480,height=720")})()';
}

/** Text that arrives while an unsaved capture is still open: both are kept, with a ― line between */
export const joinCapture = (old, text) => !String(old || '').trim() ? text : !text ? old : old.replace(/\s+$/, '') + '\n\n---\n\n' + text;
