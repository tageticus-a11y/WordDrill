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

/** The bookmarklet for the app at appUrl (query and hash are dropped; demo: keeps ?demo) */
export function bookmarklet(appUrl, demo) {
  const target = appUrl.split(/[?#]/)[0] + (demo ? '?demo&' : '?') + CAPTURE_PARAM + '=';
  // the selection, or the selected part of a text box (getSelection doesn't see inside those)
  return 'javascript:(()=>{const a=document.activeElement;' +
    'const s=a&&/^(TEXTAREA|INPUT)$/.test(a.tagName)&&a.selectionEnd>a.selectionStart?a.value.slice(a.selectionStart,a.selectionEnd):String(getSelection());' +
    'window.open(' + JSON.stringify(target) + '+encodeURIComponent(s),"worddrill-add","popup,width=480,height=720")})()';
}

/** Text that arrives while an unsaved capture is still open: both are kept, with a ― line between */
export const joinCapture = (old, text) => !String(old || '').trim() ? text : !text ? old : old.replace(/\s+$/, '') + '\n\n---\n\n' + text;
