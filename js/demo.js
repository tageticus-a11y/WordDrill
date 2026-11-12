// Demo mode (?demo in the URL): a fake Dropbox kept in this browser's storage, for trying the UI
// without touching real data. Never used unless ?demo is in the address.

export function createDemoDropbox(store) {
  const files = () => store.get('demo.files') || {};
  const save = f => store.set('demo.files', f);
  let n = Date.now();
  const conflict = () => Object.assign(new Error('Dropbox: path/conflict/file/'), { conflict: true });
  return {
    connected: () => true,
    disconnect: () => store.del('demo.files'),
    startLogin: async () => {},
    exchange: async () => {},
    api: {
      async list() { return Object.entries(files()).map(([path, f]) => ({ path, rev: f.rev })); },
      async download(path) { const f = files()[path]; return f ? { text: f.text, rev: f.rev } : null; },
      async upload(path, text, rev) {
        const all = files(), cur = all[path];
        if (rev == null ? cur : !cur || cur.rev !== rev) throw conflict();
        all[path] = { text, rev: 'd' + ++n };
        save(all);
        return { rev: all[path].rev };
      }
    }
  };
}
