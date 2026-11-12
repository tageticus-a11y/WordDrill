# WordDrill

WordDrill is a small personal app for memorizing words, phrases and facts. It has three tabs:

- **Today:** the cards you are learning now.
- **Weekly check:** cards come back here one week after you remembered them.
- **Archive:** cards you still knew at the weekly check, sorted by month.

It runs in a desktop browser and as an iPhone Home Screen app. There is no server: your cards are Markdown files in your own Dropbox.

## One-time setup
1. **GitHub Pages:** in this repo, open Settings → Pages → Source and choose **GitHub Actions**. The app is published at https://tageticus-a11y.github.io/WordDrill/.
2. **Dropbox app:** in the Dropbox App Console, the app needs:
   - scoped access, **App folder**;
   - permissions `files.metadata.read`, `files.content.read` and `files.content.write`;
   - redirect URIs `https://tageticus-a11y.github.io/WordDrill/` and `http://localhost:8000/`.
3. **Each device:** open the app and connect Dropbox.
   - On an iPhone Home Screen app, use "Connect with a code".

## Development
- **Run the tests:** `npm test`. They use Node's built-in test runner and need no dependencies.
- **Run the app locally:** `python -m http.server 8000`, then open http://localhost:8000/.
  - Add `?demo` to the address to try the app with fake data stored in the browser.
