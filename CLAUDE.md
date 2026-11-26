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
- **The queue** (v28) holds the user's raw TickTick notes (saved words, phrases, failed cards) until they are prepared; it replaced the TickTick "flow" notes. "Forgot" no longer copies to the clipboard: the card goes back into the queue (see Weekly check).

## Workflow of the user
- **Today:** one section per **area** with daily targets (Armenian 2, English 2, General 1 by default). The targets are stored in `state.json` as `targets` (by area name) and edited in Settings.
  - **Coverage** (v32; `coverage` / `coverageText` / `minCoverage` in ops.js, `coverView` in app.js): each heading shows how long Preparation lasts, P prepared / T a day: `English 2 / 2 (2.5 days)` (P/T with one decimal; a percent was shown in v32 and dropped as redundant), red under 1 day; none without a target. The hidden-list note shows it too. The **Preparation tab** shows the shortest one as `1d` (`#prepDays`, red under 1, hover names the area). For seeing which area is ready for the weekend.
- **Areas** (Settings → "Areas and cards per day"; state.json `sections` = [{key, name, removed?}], absent = the three defaults, `sectionsList` / `activeSections` in ops.js). The order there is the order everywhere.
  - The **key** never changes; it names the archive folder (`archive/<key>/`), so `archiveOp` gets the key from the list.
  - **Rename** (`renameSectionPlan`): a `rename` op rewrites the `## Name` headings in Today, Prepared and the 7 weekday files (merging into the new heading if it already exists; a missing file is not created), and the target moves to the new name. Archive files keep their old headings (history); the archive view groups by key. A name already used by another area (removed too) or by a heading that holds cards is refused.
  - **Remove** (`removeSectionPlan`): only when Today, Prepared and the weekday files hold none of its cards; the entry stays with `removed` = date, its archive stays, and adding an area with the same name (or "Bring back") restores it with the same key. At least one area stays.
  - **Add** (`addSectionPlan`): a new key from the name (not one an archive folder already uses), target 1. ↑ ↓ reorder (`moveSectionPlan`).
  - A heading in a file that isn't an active area but holds cards is still shown (`sectionsOf` in app.js), so nothing is hidden.
- **Split** ("✂ Split here" in the editor of a saved card, not the Recall boxes; `splitPlan`): the text before the cursor stays, the rest becomes a new card right below with the same meta (due in the same weekly check). The new card is added first, then the old one is edited, so an interrupted split can't lose text.
- **Split into many** (v29; `splitParts(text, mode)` + `splitAllPlan`, Undo): **✂ At ― lines** cuts at every `---` line (the ― toolbar button marks the places; the lines go) and **✂ Line by line** makes every non-empty line a card. A ``` box is never cut (line by line: it stays with the line above). Both buttons are always shown (v31; hidden until v30, so they couldn't be found), dimmed (`idle`) while the text gives fewer than 2 parts; a tap then explains. In a new card's editor they read "✂ Save line by line" / "✂ Save at ― lines", with a hint above (`manyHint`). A saved card keeps the first part, the rest go right below in order (new cards first, then the edit); in an editor for a **new** card (queue or + Add) it saves that many cards (queue: from the target index on). Works on the phone too.
- **Merge** ("Merge with next" in the ⋯ menu of Today, Prepared and Weekly check, where it takes the next due card; `mergePlan`): the lower card's text goes to the end of the upper one after a `---` line (`JOIN`; a split drops a `---` line at the cut, so splitting at the join gives both cards back), then the lower card is deleted (edit first). Both have Undo.
- **Tabs, in order:** Today, Weekly check, Preparation (called Prepared until v26; internally still `prepared` / `prepared.md` / `PREPARED`), Archive.
- **Recall on Today** (the user's routine: type the day's words from memory, then have an AI check the spelling; morning and midday; the user fills Prepared and then comes back to type Today's cards):
  - Today's list (`k` = `today`, the only Recall list; Weekly check had one in v8–v18, the user didn't want it) starts **hidden**: a Recall section with typing boxes and per-section counts. **Enter** (Return on the phone; Ctrl+Enter too; or "+ Next card") starts the next box, **Shift+Enter** adds a line inside a box. Phone keyboards, custom ones too, may send Return only as `beforeinput` (`insertLineBreak` / `insertParagraph` / `insertText` "
"), so that is handled as well; Shift+Enter sets a flag the next `beforeinput` lets through. Enter does nothing in an empty box and moves to an empty box right below instead of making another. Backspace in an empty box stays there (it used to remove the box and run on into the card above); ✕ removes a box. The iOS bar above the keyboard can't get buttons from a page; its ↑ ↓ already move between the boxes. ↓ on a box's last line goes to the box below, ↑ on its first line to the box above (nothing past the first/last box). No spellcheck or autocorrect in the boxes. The buttons update while typing ("Skip — show …" when nothing is typed).
  - "Show …" opens the list for the session (sessionStorage `wd.listShown` = date). It hides again (`hideList`) when the user **opens Prepared or Weekly check**, after 30 min in the background, and in a new session. "Hide and type again" clears the typed cards (Undo) and hides the list.
  - Showing a list marks its typed cards `shown`; the next Recall panel then starts a new round empty, with an Undo toast.
  - Typed cards live **only in this browser** (localStorage `wd.recall` = {date, items, shown}; an old `wd.recallCheck` is removed); a new day starts empty. Never written to Dropbox.
  - "Copy for AI check" copies `buildCheckText` (`js/recall.js`): the prompt with `{typed}` and `{cards}` replaced (lists appended if a placeholder is missing). The prompt is `aiPrompt` in state.json, edited in Settings; null or empty means `DEFAULT_CHECK_PROMPT`.
- **Recall timer** (like the user's CountDownPage Chrome extension, `../CountDownPage`): cycles of 10 s (21 by default), a ring that fills each cycle. **Traffic lights** (`partOf`): the milestones split a run into three parts, green / yellow / red (`--ok`, `--warn`, `--alert`); within a part the cycles take turns, the first in the part's colour, the next neutral (`--muted`), and so on, so in a neutral cycle only the background (phones) and the line show the timer runs.
  - A small ring in the header (cycles left; ⏱ when idle) opens a compact panel under the title (open by default; ✕ closes it, remembered in `wd.timerOpen`): ring with the seconds, "Cycle n / N", number of cycles, Vibrate (where possible), Start/Pause/Resume, Reset. A keyboard shortcut starts or pauses (default Alt+B; the extension's Ctrl+Shift+1 is global in Chrome).
  - Settings → Timer (state.json `timer` = {cycles, shortcut}, synced): "Cycles by default" (used for a fresh timer, after Reset and after it finishes; an idle timer takes a new value at once via `timer.refresh()` in `render()`; the panel can change it for one run) and the shortcut. "Change" records the next key combination (`shortcutOf`: modifiers + `KeyboardEvent.code`, layout-independent; Ctrl, Alt or Win/Cmd required except for F keys; Esc cancels); "Turn off" stores ''; "Default" goes back to Alt+B. The same recorder (`SHORTCUTS` / `shortcutSetting` in app.js) sets the **Copy for AI check** shortcut (state.json `aiShortcut`, default Ctrl+Shift+1, `copyShortcutOf` in recall.js): it copies Today's lists from any tab. Two actions can't share one shortcut.
  - Signals: start = "even"; each cycle end alternates "odd"/"even" dings; the last one is "final" (three beeps), then the timer resets. Milestones (`milestoneCycles` / `milestonesPassed`: the first two parts are equal with an even number of cycles, about 2/5 of the run each, so a part always ends on a neutral cycle and the next starts coloured; the last part is the smaller rest: 21 cycles → after cycles 8 and 16, 8 + 8 + 5; never at the very end, a short run may have fewer; 12 can only be 4 + 4 + 4) play the same soft bell as rising notes: 660→990 Hz for the first, 660→990→1320 Hz for the second (`milestone1` / `milestone2`, vibrate 2 / 3 pulses); a milestone replaces that cycle's ding (one sound per moment), and "final" wins over everything. iOS leaves the AudioContext "interrupted" after the app was in the background: `audioCtx()` resumes any context that isn't running, `play()` waits for the resume, and Start (`wakeAudio`, inside the tap or key press) replaces a context that isn't running and plays a silent buffer to unlock the output. Sounds are synthesized with Web Audio (no mp3s from the extension in the public repo); a ding older than 2 s (app was in the background) isn't played.
  - Vibrate (on by default, localStorage `wd.timerVibrate`): `navigator.vibrate` on a touch device (`pointer: coarse`) only, so the option shows only on phones that can (Android); desktop Chrome has `navigator.vibrate` too, with nothing to vibrate. iPhones can't vibrate from a web page: the `<input switch>` haptic trick works only on a real tap since iOS 26.5 (tried in v11, removed). The silent switch mutes the Web Audio sounds on the speaker, not in headphones.
  - While it runs, `<html>` has class `timer-running`, `--timer-color` (the cycle colour), `--timer-progress` (0…1, this cycle) and `--timer-total` (0…1, the whole run), updated every 100 ms. A page can't style the keyboard (the user types with a custom Armenian one), so:
    - A 4px line under the header fills from left to right over the **whole run** in the part's colour (`--timer-part`), with ticks at the milestones (`--timer-m1`, `--timer-m2`; two equal parts and a smaller last one).
    - The Recall boxes fill from left to right over **each cycle** in `--timer-color` (the part's colour or neutral).
    - `timer-flash` (1.3 s): when a new cycle starts, three 0.4 s pulses (in the part's colour) of the Recall boxes everywhere and, **on phones only** (`pointer: coarse`), of the whole page.
    - On phones only, body and header also keep a tint of the part's colour; a computer keeps its colours.
  - Hover texts show the current shortcuts (Start/Pause, the timer button, Copy for AI check, + Next card = Ctrl+Enter).
  - State in localStorage `wd.timer` = {total, startAt, elapsed} with wall-clock times: survives reloads and tab switches. Logic in `js/timer.js` (pure, tested), UI in `js/timer-ui.js`.
- **Preparation** (`prepared.md`; "Prepared" below means this tab): the user prepares the next cards, not in order as with Today. It works like Today (add, edit, up/down, delete) but shows **one area at a time**: a row of sub-tabs (`.subtabs`, one per area of `sectionsOf`, i.e. Settings order plus extra headings holding cards), each with its card count. A sub-tab is red when the area holds fewer cards than its daily target (not enough for tomorrow), with a note above the list. The chosen sub-tab is kept in localStorage `wd.prepArea`; an open editor in Preparation picks its area; "Open Preparation" on the low banner opens the first short area.
- **Today → Add to a queue** (`quickQueue` in app.js, at the bottom of Today in both states): area chips (localStorage `wd.quickArea`), **+ Soon** / **+ To the end** open the editor right there (same `queueTarget` as the Queue view; `editing.soon` remembers which). While it is open, the area chips and the Soon / At the end switch move the note to the new place with its text (`.keep-edit` buttons don't autosave).
- **Capture from any page** (v32, bookmarklet; `js/capture.js`, `startCapture` / `captureView` / `captureSettings` in app.js): Settings → "Add from any page" has a link to drag to the Chrome bookmarks bar (`bookmarklet(appUrl, demo)`: the selection, or the selected part of a text box, → `window.open(<app>?add=<text>, "worddrill-add", popup)`). The window (`CAPTURE`, html class `capture`) shows only the quick add with the text in the editor (review, then Save; ✂ Save line by line works); the URL is cleaned at once so a reload never adds twice; it saves at once (`captureSave`) and closes itself when Dropbox has it, else shows Try again. Cancel closes it; no autosave there. Not signed in: says so, with Copy.
  - **iPhone** (v34): an iOS Shortcut in the Share sheet (select text in any app → Share → Add to WordDrill: actions URL Encode + Open URLs `captureUrl(appUrl)` + the encoded text) opens the same capture page **in Safari**; iOS can't send shares to a Home Screen web app or open it from a page. Safari has its own storage, so it signs in to Dropbox once and is one more device. Settings → "Add from any page" shows the steps and the address (iPhone part first on touch devices). Safari can't close a page it didn't open, so with no `window.opener` a save shows a done panel (`captureDone`: what was added, "swipe back", + Add another). Not signed in: the text is kept in `wd.captureText` and comes back in the next capture, with an "Open WordDrill to sign in" link.
  - **It is a separate device:** own engine key `wd.capture` (demo `demo.capture`) and draft `wd.captureDraft`, never `wd.data` / `wd.draft`: two windows on one engine key would overwrite each other's pending ops (the engine saves its whole state). Dropbox revs and op replay merge them, as between phones. Its engine is made only once it holds the Web Lock `worddrill-capture`; the main app's `sync` first flushes ops a closed capture window left (`flushCaptureLeftovers`, lock `ifAvailable`). A note left open gets the next selection after a `---` line (`joinCapture`). Text over 20,000 characters is cut, with a note.
- **Queue** (Preparation → area sub-tab → the **Prepared N | Queue** switch, localStorage `wd.prepView`; logic in `js/queue.js`):
  - **Files:** `queue/<area-key>/0001.md`, `0002.md` … (4 digits, by key, so a rename never touches them), file format v1 **without a heading** (all cards in section `''`, `QUEUE_SECTION`). The front of the queue is the lowest number.
  - **Settings → Queue** (state.json `queue` = {fileSize, soonAfter}, `queueSettings`, both 50 by default, 5–500): cards per file and the "soon" place.
  - **New files are made only at the end:** "+ Add to the end" (`appendTarget`) uses the last file while it holds fewer than `fileSize` cards, else `last number + 1` (`0001` for an empty queue). "+ Add soon" and Forgot (`soonTarget`) insert after the first `soonAfter` cards counted across files (a shorter queue: the end). A soon insert may push a file over `fileSize`; nothing ever cascades between files.
  - **A queue file left without cards is deleted** by the sync engine (`api.remove(path, rev)`, Dropbox `files/delete_v2` with `parent_rev`): if another device changed the file meanwhile it is a conflict, so the file is re-downloaded, the op replayed and the file kept. A missing file counts as deleted. The pager hides a just-emptied file.
  - **Loading:** queue files are not in `CORE`; the shown file is loaded on demand (`loadQueueFile`), and `queueTarget(key, soon)` loads the front files (soon) or the last one (end). Offline with unloaded files: soon → index `soonAfter` in the front file, end → the end of the last file.
  - **View:** one file at a time, "File n of N · M cards" with ‹ ›. Cards are normal read-only cards (✎ Edit, ✂ Split — one block may hold several words). **↑ Prepared** (`queueToPreparedPlan`) puts the card at the **bottom** of that area in Prepared. ⋯: ↑ ↓, Merge with next, **To the end of the queue** (`queueToEndPlan`: an `order` op when it is already in the last file, else a move), Delete. All with Undo.
  - An area with queue files can't be removed (`removeSectionPlan(…, queueFileCount)`).
  - **Import:** `node scripts/import-queue.mjs <notes.txt> <area-key> <app-folder> [--size 50] [--drop <exact block>] [--date …]` splits the notes at empty or whitespace-only lines (`splitBlocks`), writes `queue/<key>/NNNN.md` into the local Dropbox app folder (the Dropbox app uploads them), refuses if the folder exists, and checks the round trip before writing. English was imported on 2026-11-24 from `FlowSnapShot.txt` (1,507 cards, 31 files; the user's `Break` marker block was dropped, "Add soon" replaces it); Armenian on 2026-11-24 from `ArmeniansSnapShot.txt` (475 cards, 10 files, nothing dropped).
- **Cards are read-only** (the user mostly copies text from them). A tap on the text does nothing; **✎ Edit**, right after the main button on every editable card (Today, Prepared, Weekly check), opens the editor. Saving is unchanged (Save, Ctrl+Enter, or autosave when the focus leaves), and the card is read-only again. The Recall boxes are always editable. Today's main button is a bare **✓** (title "Remembered").
- **✓ Remembered** moves a card to today's weekday file, and the cards below it move up. If the section is then below its target, the **top** Prepared card of the same section joins Today at the bottom, with meta `started=date`. If Today had more cards than the target, nothing is refilled. See `rememberPlan` in `ops.js`; its Undo restores both cards.
- **Moving cards by hand:** "← Today" on a Prepared card pushes it into Today regardless of the target. "Preparation →" in Today's ⋯ menu puts a card back at the top of Prepared. Arrows (and the slide-out direction, `leave(ev, fn, 'left')`) point to where the target tab is.
- **Prepared warnings:**
  - When a section of Prepared holds fewer cards than its target (`preparedShortage`), the Prepared tab gets a red dot and Today shows a "Preparation is running low" banner.
  - When a section is completely empty, the Prepared tab also blinks three times (when that happens or the app opens), not constantly.
- **Weekly check:** on the same weekday a week later, each card that is due starts **collapsed**: only its first line shows, so the answer can't be peeked at. "Show answer" (or a tap) reveals it. Then the card gets one of two answers:
  - **Still know** → archive.
  - **Forgot** → back into the area's queue at the "soon" place (`forgotPlan`: a move, queue file first; `moved` dropped, `forgot=date` added; Undo). A card under a heading that isn't an area is still deleted and its text copied.
- **Typing in the Weekly check:** each collapsed card has a box (class `typed check-typed`, `checkBox` in app.js) to type what the user remembers; no AI check here. Ctrl+Enter in the box shows the answer; ↓/↑ on the last/first line go to the next/previous card's box. A revealed card shows **"You typed" and "Card" side by side** (`cardView(..., {typed})`, `.compare`; stacked below 340px). The text lives only in this browser: localStorage `wd.checkTyped` = {date, byId} (`checkTypedFor` in recall.js), cleared on a new day. The timer colours and flashes these boxes like the Recall ones.
- **Card buttons** (`cardButtons` in app.js; Today, Preparation, Queue): on a computer (`(hover: hover) and (pointer: fine)`) ↑ ↓ stay in the row after ✎ Edit and Delete sits at the right end; the rest is under ⋯. On a phone (touch) ↑ ↓ and Delete are under ⋯ too, as before (the row is narrow).
- **Wrong section:** "Move to…" in the ⋯ menu (Today, Prepared, Weekly check) moves a card to another section of the same file.
- **Remembered by mistake:** in Weekly check, the note "N cards remembered today" has Show/Hide. The list it opens offers "← Back to Today" (`backToTodayOp` drops the `moved` date).
- **Weekly check reminder:** a red dot on the tab and a banner on Today (above the Prepared one) whenever today's weekday file has cards from earlier weeks (`dueToday`). The check is done when none are left. There is no "Mark done" button any more; an old `weekCheckDone` in `state.json` is ignored and kept.

## Data layout in Dropbox (paths are lowercase, relative to the app folder)
```
current.md                     cards being learned now (Today)
prepared.md                    next cards, top first (Prepared)
week/1-mon.md … week/7-sun.md  remembered on that weekday; due when meta.moved < today (or no moved)
archive/<section-key>/YYYY-MM.md  passed the check; one file per section per month (key: armenian/english/general)
state.json                     { "sections": [{ "key": "armenian", "name": "Armenian" }, …, { "key": "x", "name": "X", "removed": "2026-11-23" }], "targets": { "Armenian": 2, ... }, "aiPrompt": "…" | null, "aiShortcut": "Ctrl+Shift+Digit1", "timer": { "cycles": 21, "shortcut": "Alt+KeyB" }, "queue": { "fileSize": 50, "soonAfter": 50 } }   (old "weekCheckDone" is ignored and kept)
queue/<area-key>/NNNN.md       raw notes waiting to be prepared, front = lowest number, no heading (see Queue)
```

## File format v1 — must stay backward compatible
```
<!-- worddrill v1 -->

## Armenian

<!-- card id=k3x9a added=2026-11-12 moved=2026-11-12 -->
card body: free Markdown (bold, italic, ~underline~, > quotes, lists, ``` box ```)

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
  - `started`: the date it came from Prepared into Today.
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
  - **Op types:** `add`, `edit`, `delete`, `order`, `move`, `section` (to another section of the same file), `rename` (a heading in several files, `paths`), `state`.
  - **Plans** (pure, tested in `test/areas.test.js`): `rememberPlan`, `splitPlan`, `splitAllPlan` (with `splitParts`), `mergePlan`, and the area plans, which return `{ops, undo, message}` or `{error}`.
  - **Moves:** `opTargets(op)` gives the files to write in order. A move writes **the target first, then the source**, so an interrupted move can duplicate a card but never lose it.
  - **Edit of a missing card:** an `edit` whose card is no longer in its file (moved or deleted elsewhere) re-adds the card, so the edited text is kept.
  - **Unknown op types** leave files untouched.
- `sync.js` (pure, with the api and storage injected): `createEngine`. The api is `list` / `download` / `upload` / `remove` (remove: only at a rev; for emptied queue files).
  - **State:** `data.files[path] = {text, rev, remoteRev}` (the last known Dropbox text), plus `data.ops`, the queue of pending ops, persisted in localStorage `wd.data`.
  - **What the UI shows:** `doc(path)` = the base text with the pending ops applied.
  - **`flush`:** for each op and each target file:
    1. Apply the op to the latest text.
    2. Upload with that text's rev.
    3. On a conflict, re-download and replay; ops are idempotent.
    4. Skip the upload if nothing changed, which happens when replaying after a lost reply.
  - An op is removed from the queue only after all its files are saved.
  - **Batching** (v30): a run of consecutive ops that all touch only the same one file (a split into hundreds of cards, many edits) is applied together and uploaded **once**; an op with several files (a move) ends the run, so the order between files is kept. Before v30 every op was its own upload, and a big split kept the app "Syncing…" for minutes.
  - `dropbox.js` waits and retries a 429 (too many requests) up to 3 times, as `Retry-After` asks (at most 15 s).
  - **`sync(core)`:** flush → list the folder → download the core files and already-loaded files whose rev changed → flush.
  - **Archive files** download lazily (`load`).
  - **Conflicts are merged by replaying ops.** There are no "(my version)" copies as in Stanzas.
- `markdown.js`: the subset is **bold**, *italic*, ~underline~ or ~~underline~~ (not strikethrough), `inline code`, and ``` boxes (shown in a tinted monospace box, meant for etymology; their content isn't parsed), headings `# …` to `###### …` (`HEADING_RE`; a body line starting with `## ` is saved escaped as `\## ` by the file format, `# ` and `### ` need no escape), horizontal lines `---` / `***` / `___` (`HR_RE`; always a line, never a setext heading underline; a collapsed card skips a leading one), and GFM pipe tables (header row, `| --- | :-: |` delimiter row with the same cell count, `\|` for a literal pipe; shown scrollable sideways; a collapsed card shows only the first cell). The toolbar has B I U H (`# ` line prefix) ❝ • 1. { } ⊞ (`insertTable`) ― (`insertRule`).
  - **Parsing (pure):** `parseBlocks` / `parseInline` for the Markdown subset; single newlines become line breaks.
  - **Rendering:** `toDom` builds nodes with `createElement` and text nodes only, never `innerHTML` with user content.
  - **Toolbar text edits:** `toggleWrap` and `toggleLinePrefix`.
- `dropbox.js`: browser only.
  - PKCE sign-in: redirect, or the paste-code fallback for iOS Home Screen apps, whose storage is separate from Safari's.
  - The `list` / `download` / `upload` API.
  - `hdr()` escapes non-ASCII characters in `Dropbox-API-Arg`. Armenian paths would break without it.
  - The app key is in `DROPBOX_APP_KEY`; it is public by design.
- `queue.js` (pure): `queueSettings`, `queuePath` / `queueFiles` / `isQueueFile` / `queueNumber`, `appendTarget`, `soonTarget`, `splitBlocks`, `chunk`.
- `capture.js` (pure): `captureText`, `captureUrl`, `bookmarklet`, `joinCapture`, `CAPTURE_LOCK`.
- `recall.js` (pure): `recallFor`, `checkTypedFor`, `typedTexts`, `promptOf`, `buildCheckText`, `DEFAULT_CHECK_PROMPT`, `copyShortcutOf`.
- `timer.js` (pure): `timerState`, `timerView`, `startTimer` / `pauseTimer` / `resetTimer` / `setTotal`, `cycleEnds`, `MILESTONES` / `milestoneCycles` / `milestonesPassed` / `partOf`, `timerSettings`, `shortcutOf` / `matchesShortcut` / `shortcutLabel`. `timer-ui.js`: `mountTimer({button, panel, store, settings})` → `{refresh}`.
- `demo.js`: `?demo` in the URL uses a fake Dropbox kept in localStorage (`demo.files`, `demo.data`). Use it for UI testing without touching real data.
- `app.js`: the UI (tabs Today / Weekly check / Archive / Settings).
  - **Every change** goes through `commit(ops, message, undoOps)` (each argument is one op or a list) → `engine.add` → render → `flush` after 600 ms.
  - **Undo:** Delete, Remembered, Still know, Forgot and the queue moves show an Undo toast that builds the inverse op.
  - **Motion:** `leave(ev, fn)` slides a card out (200 ms) before its change is committed. After every commit, `render()` uses FLIP (`cardRects` / `playMoves`, keyed by `data-id`): the cards below glide up (380 ms) and new cards rise from below (650 ms). Motion is off with `prefers-reduced-motion`.
  - **Editing:**
    - An open editor is stored as a draft (`wd.draft`) and survives reloads.
    - **Autosave:** the open card is saved when the focus leaves it (`autoSave`). Triggers: a click outside the editor (a capture-phase listener on document saves first, then the click does its job), switching tabs, the app going to the background, and a textarea blur not followed by a click within 400 ms (keyboard focus moves; iOS taps without a click). Switching windows (`!document.hasFocus()`) doesn't save. Editor buttons use `mousedown` preventDefault so they keep the focus. Save stays as a button; an empty card is not autosaved.
    - **No scroll jumps (iOS):** text boxes fit their text with `fitHeight` (grows without measuring; shrinking sets height auto for a moment inside `keepScroll`, which puts the page back). Toolbar edits change only the differing part (`replaceText`, `setRangeText`) instead of replacing the whole value, and refocus with `preventScroll`. Before v24 the { } button made iPhone jump to the top of the card.
    - **Earlier versions:** `js/versions.js` keeps each card's earlier texts for this session only (sessionStorage `wd.versions`, at most 20 per card). The ↺ N button in the editor lists them and puts one back in the box. Nothing of this goes to Dropbox.
  - **Rendering:**
    - Renders caused by sync or a visibility change go through `backgroundRender`, which waits while the editor textarea has focus.
    - User actions always call `render()` directly. iOS buttons don't take focus, so deferring those would freeze the UI.

## Conventions
- Build the DOM with the `h()` helper, `textContent` and `toDom`.
- Phone first, with a 760px max width. iOS safe areas are respected, `maximum-scale=1` prevents zoom on focus, inputs are 16px, and `main` uses `overflow-x: clip`.
- The theme is a blue dark or light palette, chosen automatically through `prefers-color-scheme`.
- **On every release that changes app files, bump `CACHE` in `sw.js` and `APP_VERSION` in `js/app.js` together.** A test enforces that they match and that `SHELL` lists every `js/*.js`. Without the bump, installed phones keep the old version.
- Icons: `node scripts/make-icons.mjs` makes icon-180/192/512.png from `scripts/icon-source.png` (a Rolodex spun by a drill, "WordDrill"; made by the user with ChatGPT; not deployed) with a dependency-free PNG decoder and area resampling. To change the icon, replace the source and run the script.

## Testing
- **Unit tests:** `npm test` (`node --test`, no dependencies; Node 24 locally, and CI uses 24).
  - `test/format.test.js`: golden fixtures, round trips and escaping.
  - `test/ops.test.js`: idempotency, keeping the card count, and interrupted moves.
  - `test/sync.test.js`: an in-memory fake Dropbox with revs and injected failures (network errors, a lost reply after a write, two devices).
  - `test/release.test.js`: checks the service worker list and the matching versions.
- **Manual UI check:**
  1. Serve the folder on `http://localhost:8000/` with a server that sends `.js` as `text/javascript` (on this PC `python -m http.server` sends text/plain and the modules don't load; a few lines of Node `http` do).
  2. Open `/?demo`.
  3. Headless Edge is at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` and can be driven over CDP; Chrome isn't installed.
- **Real Dropbox locally:** works through `http://localhost:8000/`, which is registered as a redirect URI. It touches real data.
- **Bash tool quirk:** it can collapse `\\` inside heredocs. Write files that contain backslashes with the Write tool or with Node.

## Deploy
- `git push` to `main`. GitHub Actions (`.github/workflows/pages.yml`) runs the tests and, if they pass, deploys only the app files to Pages.
- In the repo settings, Pages → Source must be **GitHub Actions**.
- URL: https://tageticus-a11y.github.io/WordDrill/
- Dropbox redirect URIs: that URL and `http://localhost:8000/`.
