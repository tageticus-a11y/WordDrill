# WordDrill

A personal PWA for memorizing words, used in desktop Chrome and as an iPhone Home Screen app. It replaces a TickTick routine of a daily note, weekday notes and a Flow queue.

- **No server and no build step.** It is plain ES modules, hosted on GitHub Pages; the repo is **public**.
- **All data** is Markdown files in Dropbox → Apps → WordDrill (scoped app, App folder access).
- **Sibling project:** `../Stanzas` uses the same stack. Its Dropbox code was the starting point here.

## Working rules (from the user)
- **Commit and push to `main` without asking.**
- **Releases must never lose data.**
  - Run `npm test` before every commit. The pre-commit hook does this once `git config core.hooksPath .githooks` is set; it is set in this clone.
  - CI runs the tests again and deploys only if they pass.
  - Add tests together with every change to the format, ops or sync code.
- **All UI labels are in English.** Card content is Armenian, English and Russian, so everything must be Unicode-safe.
- **Never commit real word lists.** Test data is made-up placeholder text.
- **Flow and the queue are not built yet.** They come later, with a data transfer from TickTick. A card marked "Forgot" is deleted; its text goes to the clipboard so the user can paste it back into TickTick. The app keeps no copy.

## Workflow of the user
- **Today:** three sections (Armenian, English, General). There are no daily targets; the user adds as many cards as they want.
- **✓ Remembered** moves a card to today's weekday file.
- **Weekly check:** on the same weekday a week later, each card that is due gets one of two answers:
  - **Still know** → archive.
  - **Forgot** → deleted, text copied to the clipboard.
- **Reminder:** a banner at the bottom of Today shows until "Mark weekly check done" is pressed for that day. The `weekCheckDone` date in `state.json` is synced across devices.

## Data layout in Dropbox (paths are lowercase, relative to the app folder)
```
current.md                     cards being learned now
week/1-mon.md … week/7-sun.md  remembered on that weekday; due when meta.moved < today (or no moved)
archive/<section-key>/YYYY-MM.md  passed the check; one file per section per month (key: armenian/english/general)
state.json                     { "weekCheckDone": "YYYY-MM-DD" }
```
Later releases add `flow/` and `queue/` next to these.

## File format v1 — must stay backward compatible
```
<!-- worddrill v1 -->

## Armenian

<!-- card id=k3x9a added=2026-11-12 moved=2026-11-12 -->
card body: free Markdown (bold, italic, > quotes, lists)

## English
...
```
**Structure**
- Section headings are `## Name`. Each card starts at a `<!-- card id=… key=value … -->` marker, and its body runs to the next marker or heading.
- Leading and trailing blank lines of a body are trimmed.
- Meta values are URI-encoded, and `id` is always the first key. Keys in use:
  - `added`: the date the card was created.
  - `moved`: the date it was remembered.
  - `archived`: the date it passed the check.
  - Unknown keys are preserved.

**Escaping:** a body line that would read as structure (`## `, `##`, `<!-- card`, `<!-- worddrill`) is saved with one extra leading `\`. Loading removes exactly one, so the escape can be reversed for any number of backslashes.

**Nothing is ever dropped:**
- Text outside a card marker (typed by hand in Dropbox) becomes a card of its own.
- Text before the first heading goes into a section named `''`, written without a heading.
- A card with a missing or duplicate id gets a deterministic id: `hashId` of the section, position and body.

**Golden fixtures** (`test/fixtures/v1/` plus `expected.json`) are frozen.
- Never edit or delete them.
- If the format changes, bump the header version, keep the parser able to read every older version, and add `test/fixtures/v2/`.

## Architecture (`js/`)
- `format.js` (pure): `parseDoc` / `serializeDoc`, `parseState` / `serializeState`. `serializeDoc` output is canonical.
- `dates.js` (pure):
  - Local `YYYY-MM-DD` dates.
  - `weekFile(date)` → `week/4-thu.md`.
  - `isDue`.
  - `archiveFile(key, date)`.
- `ops.js` (pure): the op builders and `applyOp(op, path, doc)`, which is **idempotent**.
  - **Op types:** `add`, `edit`, `delete`, `order`, `move`, `state`.
  - **Moves:** `opTargets(op)` gives the files to write in order. A move writes **the target first, then the source**, so an interrupted move can duplicate a card but never lose it.
  - **Edit of a missing card:** an `edit` whose card is no longer in its file (moved or deleted elsewhere) re-adds the card, so the edited text is kept.
  - **Unknown op types** leave files untouched.
- `sync.js` (pure, with the api and storage injected): `createEngine`.
  - **State:** `data.files[path] = {text, rev, remoteRev}` (the last known Dropbox text), plus `data.ops`, the queue of pending ops, persisted in localStorage `wd.data`.
  - **What the UI shows:** `doc(path)` = the base text with the pending ops applied.
  - **`flush`:** for each op and each target file:
    1. Apply the op to the latest text.
    2. Upload with that text's rev.
    3. On a conflict, re-download and replay; ops are idempotent.
    4. Skip the upload if nothing changed, which happens when replaying after a lost reply.
  - An op is removed from the queue only after all its files are saved.
  - **`sync(core)`:** flush → list the folder → download the core files and already-loaded files whose rev changed → flush.
  - **Archive files** download lazily (`load`).
  - **Conflicts are merged by replaying ops.** There are no "(my version)" copies as in Stanzas.
- `markdown.js`:
  - **Parsing (pure):** `parseBlocks` / `parseInline` for the Markdown subset; single newlines become line breaks.
  - **Rendering:** `toDom` builds nodes with `createElement` and text nodes only, never `innerHTML` with user content.
  - **Toolbar text edits:** `toggleWrap` and `toggleLinePrefix`.
- `dropbox.js`: browser only.
  - PKCE sign-in: redirect, or the paste-code fallback for iOS Home Screen apps, whose storage is separate from Safari's.
  - The `list` / `download` / `upload` API.
  - `hdr()` escapes non-ASCII characters in `Dropbox-API-Arg`. Armenian paths would break without it.
  - The app key is in `DROPBOX_APP_KEY`; it is public by design.
- `demo.js`: `?demo` in the URL uses a fake Dropbox kept in localStorage (`demo.files`, `demo.data`). Use it for UI testing without touching real data.
- `app.js`: the UI (tabs Today / Weekly check / Archive / Settings).
  - **Every change** goes through `commit(op, message, undoOp)` → `engine.add` → render → `flush` after 600 ms.
  - **Undo:** Delete, Remembered, Still know and Forgot show an Undo toast that builds the inverse op.
  - **Editing:** an open editor is stored as a draft (`wd.draft`) and survives reloads.
  - **Rendering:**
    - Renders caused by sync or a visibility change go through `backgroundRender`, which waits while the editor textarea has focus.
    - User actions always call `render()` directly. iOS buttons don't take focus, so deferring those would freeze the UI.

## Conventions
- Build the DOM with the `h()` helper, `textContent` and `toDom`.
- Phone first, with a 760px max width. iOS safe areas are respected, `maximum-scale=1` prevents zoom on focus, inputs are 16px, and `main` uses `overflow-x: clip`.
- The theme is a warm dark or light palette, chosen automatically through `prefers-color-scheme`.
- **On every release that changes app files, bump `CACHE` in `sw.js` and `APP_VERSION` in `js/app.js` together.** A test enforces that they match and that `SHELL` lists every `js/*.js`. Without the bump, installed phones keep the old version.
- Icons are generated by `node scripts/make-icons.mjs`.

## Testing
- **Unit tests:** `npm test` (`node --test`, no dependencies; Node 24 locally, and CI uses 24).
  - `test/format.test.js`: golden fixtures, round trips and escaping.
  - `test/ops.test.js`: idempotency, keeping the card count, and interrupted moves.
  - `test/sync.test.js`: an in-memory fake Dropbox with revs and injected failures (network errors, a lost reply after a write, two devices).
  - `test/release.test.js`: checks the service worker list and the matching versions.
- **Manual UI check:**
  1. Serve the folder on `http://localhost:8000/`, for example with `python -m http.server 8000`.
  2. Open `/?demo`.
  3. Headless Edge is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` and can be driven over CDP; Chrome isn't installed.
- **Real Dropbox locally:** works through `http://localhost:8000/`, which is registered as a redirect URI. It touches real data.
- **Bash tool quirk:** it can collapse `\\` inside heredocs. Write files that contain backslashes with the Write tool or with Node.

## Deploy
- `git push` to `main`. GitHub Actions (`.github/workflows/pages.yml`) runs the tests and, if they pass, deploys only the app files to Pages.
- In the repo settings, Pages → Source must be **GitHub Actions**.
- URL: https://tageticus-a11y.github.io/WordDrill/
- Dropbox redirect URIs: that URL and `http://localhost:8000/`.
