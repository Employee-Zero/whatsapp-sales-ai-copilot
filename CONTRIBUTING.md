# Contributing

Thanks for considering a contribution. This extension operates a real WhatsApp
Web session and sends real messages, so the safety rules in section 4 are not
optional — read them before you run anything.

Before you start, `AGENTS.md` is the repository's rules file. It is the
authoritative statement of what may and may not be done here; this document is
the short version aimed at a human contributor.

---

## 1. Reporting a bug

Open an issue with enough detail to reproduce it. For this project, that means:

- **What you expected and what happened.** One sentence each is enough, but say
  which of the two buttons was involved — *Generate Reply* (preview only) or
  *Follow-up & Send* (reads, generates and sends in one step).
- **Chrome version**, and your OS. The extension targets Chrome 116+, and
  Chrome's debugging restrictions differ sharply by version.
- **Extension version**, from `manifest.json` or `chrome://extensions`.
- **Reproduction steps** that start from a known state: which panel state, what
  the conversation looked like (paraphrased), what you clicked, in what order.
- **The exact error text** the panel showed. The error codes are meaningful and
  map to specific causes; a paraphrase loses that.
- **Whether the draft was affected, the send was affected, or both.**

What makes a report good here specifically:

- If it involves the wrong recipient, a cancelled send, or a confirmation you
  were not shown, say so in the title. Those are the failures that matter most,
  and they are treated as urgent.
- If it is about the number display, say whether the chat was a saved contact, an
  unsaved number, or a group — the three take different code paths.
- If it is about an empty or truncated reply, include the reply length and
  thinking mode you had selected. Those two settings decide the token budget, and
  the failure is usually a budget that was too small for the model to finish
  thinking *and* write.
- If you can reproduce it twice, say so. Intermittent reports are still useful,
  but the two are triaged differently.

Attach screenshots only if they contain no real customer data — see section 4.

---

## 2. Pull requests

1. Fork the repository and create a branch off `main`.
2. Make the change. If you edited `src/shared/constants.js` or
   `src/shared/utils.js`, regenerate the classic copies:
   ```bash
   node tools/build-classic.js
   node tools/build-classic.js --check   # must exit 0
   ```
   A stale copy fails silently in the browser, so a PR that forgets this can look
   correct and be broken.
3. Run the offline tests:
   ```bash
   node tools/test-safety.js             # must print FAIL: 0
   ```
4. If your change touches the side panel, also run the bridge test described in
   `docs/TESTING.md` §2. If it touches prompt assembly, run the AI-path test —
   bearing in mind it makes real, billable calls.
5. Open the PR. In the description, state:
   - what changed and why;
   - which tests you ran, and their assertion counts;
   - **what you verified in a real browser, and how.** "Ran the offline tests"
     is not evidence for anything involving the DOM, the send path, or
     `chrome.storage`. Say what you clicked and what you observed.
   - anything you could not verify, and why. An honest gap is far more useful
     than a claim someone else has to disprove.

Keep pull requests focused. A change to the DOM adapter, a change to the prompt
and a UI restyle are three PRs, not one — the send path is the part of this
project where an unrelated change in the same diff is hardest to review.

---

## 3. Coding conventions

These are the conventions actually in use in this repository.

- **No dependencies.** No npm packages, no `package.json`, no build step for
  `src/`. `tools/` uses Node built-ins and the global `fetch` / `WebSocket`. If a
  change seems to need a library, it probably needs a smaller change.
- **Comments explain why, not what.** The code says what it does. A comment earns
  its place by recording the reason a non-obvious choice was made — the failure
  it prevents, the alternative that was rejected, the measurement behind a
  constant. Several comments in this repository name the specific defect they
  guard against; keep that standard.
- **No emoji in code, comments, commit messages or documentation.** The check and
  cross marks that the test scripts print are the single exception.
- **English identifiers.** Variables, functions, constants, storage keys, message
  types and CSS classes are all English. So are code comments.
- **Never return a bare string error.** Messages cross
  `chrome.runtime.sendMessage` as `{ ok: true, ... }` or
  `{ ok: false, code, message }`. The codes live in `ERR` in
  `src/shared/constants.js`; add one there rather than inventing a code at the
  call site.
- **Keep the layers apart.** All WhatsApp DOM knowledge belongs in
  `src/content/whatsapp-adapter.js`. The adapter must not contain AI calls,
  network requests or business orchestration. The service worker orchestrates;
  the panel renders.
- **Respect the generated files.** `src/shared/*.classic.js` are generated. Edit
  the module next to them, then run `node tools/build-classic.js`.
  `src/test/panel-probe.classic.js` is *not* generated despite the suffix: it is a
  classic script on purpose, so that it shares the side panel's lexical scope.
- **Fix the cause, not the symptom.** If a guard fires when it should not, do not
  widen the guard — work out why it fired. The guards in the send path exist
  because of specific real failures.

---

## 4. Safety rules a contributor must follow

The full set is in `AGENTS.md` §2 and §3. The ones most likely to come up while
contributing:

- **Never commit an API key**, a token, an `Authorization` header, or any file
  containing one. Keys belong in the extension's Settings, which stores them in
  `chrome.storage.local` in the user's own profile. The repository ships no
  default key: the default config has an empty string for the key, the model and
  both base URLs.
- **Never commit real customer data.** No real phone numbers, contact names, chat
  excerpts, transcripts or request bodies. Use placeholders such as
  `+1 555 010 0000` in tests, docs, issues and commit messages.
- **Never commit screenshots showing real chats.** Crop or redraw them, or use a
  synthetic conversation. This includes screenshots pasted into a pull request or
  an issue.
- **Do not copy a browser profile to get a debuggable session**, do not create a
  throwaway profile for testing, and never run two Chrome instances on one
  user-data-dir. WhatsApp Web's linked-device credentials can be held by two
  sessions at once, and the server invalidates the earlier one — that is how a
  working login is permanently lost.
- **Do not close, restart or clean up a running browser** without asking, and
  never delete or rebuild WhatsApp's IndexedDB, Local Storage or cookies.
- **Never send test content to a real customer.** Test sends go only to an
  account you control.
- If you need automated DOM access, use the **test bridge**
  (`docs/DEVELOPMENT.md` §7). It exists so that no debugging port, and therefore
  no second profile, is ever needed. Chrome 154 and later refuse to open a
  remote-debugging port on the default user-data-dir, and CDP tooling in `tools/`
  can only point at a non-default one.

---

## 5. Scope

Phase 1 is deliberately narrow: read the conversation currently open in
WhatsApp Web, generate a follow-up, preview it, and let the user send it. There
is no backend. Automatic scrolling, chat-list scanning, batch follow-up and CRM
integration are out of scope for now; a pull request adding one of them will be
asked to wait for the phase that introduces it.

This is a personal-use tool rather than a Web Store product. A Web Store release
would need a privacy policy, a permissions review and store documentation that
the repository does not currently carry.
