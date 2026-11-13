// Earlier texts of cards, kept for the current session only (sessionStorage in the app): a safety net
// for autosave. Nothing here goes to Dropbox. Pure functions; the app supplies the storage.

export const MAX_VERSIONS = 20;

/** Adds text as the newest earlier version of a card, unless it equals the newest one already kept */
export function addVersion(list, text, at) {
  const l = Array.isArray(list) ? list : [];
  if (!text || (l.length && l[l.length - 1].text === text)) return l;
  return l.concat({ text, at }).slice(-MAX_VERSIONS);
}

export function createVersions(storage, key = 'wd.versions') {
  const all = () => storage.get(key) || {};
  return {
    /** Newest first */
    list: id => (all()[id] || []).slice().reverse(),
    add(id, text, at = Date.now()) {
      if (!id) return;
      const a = all();
      a[id] = addVersion(a[id], text, at);
      storage.set(key, a);
    }
  };
}
