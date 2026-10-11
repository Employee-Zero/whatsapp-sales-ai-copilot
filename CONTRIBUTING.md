# Contributing

Thanks for considering a contribution. This extension operates a real WhatsApp
Web session and sends real messages, so the safety rules in section 4 are not
optional — read them before you run anything.

Before you start, `AGENTS.md` is the repository's rules file. It is the
authoritative statement of what may and may not be done here; this document is
the short version aimed at a human contributor.

There are two runnable components. The extension is one: it is what a user
installs, and it works on its own with an API key. The other is the local helper
under `helper/`, which the optional *ChatGPT subscription* connection method
needs and which runs on the user's own machine. What a change to either of them
has to satisfy is in sections 2 to 4.

---

## 1. Reporting a bug

Open an issue with enough detail to reproduce it. For this project, that means:

- **What you expected and what happened.** One sentence each is enough, but say
  which of the two buttons was involved — *Generate Reply* (preview only) or
  *Follow-up & Send* (reads, generates and sends in one step).
- **Chrome version**, and your OS. The extension targets Chrome 116+, and
  Chrome's debugging restrictions differ sharply by version.
- **Extension version**, from `manifest.json` or `chrome://extensions`.
- **Which connection method** was selected — *Your own API key* or *ChatGPT
  subscription*. If it was the subscription, say whether the local helper was
  running and whether the panel offered a sign-in. Do not paste the helper's
  terminal output: once signed in, it prints the account's email label, which is
  not something to put in an issue.
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
4. If your change touches `helper/`, run its suite too:
   ```bash
   node tools/test-helper.js             # must print FAIL: 0
   ```
   It needs Node and nothing else — no browser, no account, no network. If you
   changed a value both halves hold — the scopes, the resource, the default
   helper address, an error code — change it on both sides; this suite fails when
   the two copies drift apart.
5. If your change touches the side panel, also run the bridge test described in
   `docs/TESTING.md` §2. If it touches prompt assembly, run the AI-path test —
   bearing in mind it makes real, billable calls.
6. Open the PR. In the description, state:
   - what changed and why;
   - which tests you ran, and their assertion counts;
   - **what you verified in a real browser, and how.** "Ran the offline tests"
     is not evidence for anything involving the DOM, the send path, or
     `chrome.storage`. Say what you clicked and what you observed.
   - if your change touches the subscription method: whether you completed a real
     sign-in with a real account. `node tools/test-helper.js` proves the shape of
     the request, not that OpenAI accepts it, so "the helper tests pass" is not
     evidence that the method works.
   - anything you could not verify, and why. An honest gap is far more useful
     than a claim someone else has to disprove.

Keep pull requests focused. A change to the DOM adapter, a change to the prompt
and a UI restyle are three PRs, not one — the send path is the part of this
project where an unrelated change in the same diff is hardest to review.

---

## 3. Coding conventions

These are the conventions actually in use in this repository.

- **No dependencies.** No npm packages, no build step for `src/`, and no
  `package.json` at the repository root. `tools/` uses Node built-ins and the
  global `fetch` / `WebSocket`. The one `package.json` in the repository is
  `helper/package.json`, and its `dependencies` must stay empty: the helper is
  downloaded and run by someone who has nothing installed but Node. If a change
  seems to need a library, it probably needs a smaller change.
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
- **The helper stands on its own.** `helper/` is the second runnable component in
  this repository: its own package, its own entry point, and no import in either
  direction — nothing under `helper/` may import from `src/`, and `src/` may not
  reach into `helper/`, which is not in the extension archive at all. The two
  halves share a protocol, not code. It has to keep running on **Node 20 or
  later**, the floor `helper/package.json` declares, and it is started by a user
  typing the command the panel shows them, so its command line and its output are
  part of the interface.
- **The helper uses no ChatGPT-internal endpoint.** It calls the public Responses
  API on `api.openai.com`, with `store: false`, and OpenAI's documented sign-in
  flow over a `127.0.0.1` callback, and nothing else. `node tools/test-helper.js`
  fails if `backend-api` or `chatgpt.com` is named in `helper/lib/responses.js`
  outside a comment. Keep the request body to the parameters that module builds:
  sending one of the others back is what makes the plan refuse the request.
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
  both base URLs. The subscription method's credential is the same kind of
  secret in a different place: the helper's `credentials.json` holds the access,
  refresh and ID tokens, it lives outside the repository by design, and it is
  never copied into a fixture, a report or a screenshot. The extension itself
  must keep holding no token of any kind — that is what the helper exists for,
  and `node tools/test-safety.js` fails if a token or secret field name turns up
  in the panel, the worker, the shared layer or the extension's helper client.
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
is no backend: the optional local helper under `helper/` runs on the user's own
machine and holds their own credential, and nobody operates it for them.
Automatic scrolling, chat-list scanning, batch follow-up and CRM integration are
out of scope for now; a pull request adding one of them will be asked to wait for
the phase that introduces it.

This is a personal-use tool rather than a Web Store product. A Web Store release
would need a privacy policy, a permissions review and store documentation that
the repository does not currently carry.
