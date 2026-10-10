# AGENTS.md — rules for working in this repository

> This file is the **common rulebook for every AI development tool in this
> repository**: Claude Code, Codex, Paseo and any other agent working here must
> follow it.
>
> Spec version **v3.0**, finalised **2026-10-11**. Change this file before you
> change code or documentation.
>
> Division of labour with `docs/DEVELOPMENT.md` (environment facts and what was
> actually measured) and `docs/TESTING.md` (verification results): **this file
> says what you must do; those two say what was observed.**

---

## 1. This extension touches a real account, so the rules matter more than the code

It reads the **WhatsApp Web session that is currently signed in**, and it sends
**real messages**. During development, the easiest damage to cause is not bad
code:

- breaking the login state of a browser profile someone is actively using;
- getting a valuable WhatsApp linked-device session invalidated by the server;
- sending test content to real customers.

The technical constraint in §2 and the red lines in §3 exist for exactly those
three things.

---

## 2. Chrome's remote-debugging restriction (hard constraint)

From Chrome 136 the restriction tightens, and from 154 it is total:

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

The test is the **path itself**: passing `--user-data-dir="<the default
directory>"` explicitly is refused just the same. The process starts normally,
but the debugging port never listens and `DevToolsActivePort` is never written.

Two facts follow, and **do not try to reconcile them**:

| Scenario | Profile you may use |
|---|---|
| Day-to-day browser testing (a human clicks, reads logs, reads storage) | the profile you use daily |
| Automated testing that needs CDP remote debugging | a **non-default** User Data directory |

**Workarounds that are explicitly forbidden:**

- ❌ copying a daily profile's login data into another directory so that a
  debuggable session exists (WhatsApp linked-device credentials would then be
  held by two sessions at once → the server honours the later one and
  invalidates the earlier)
- ❌ letting two Chrome processes share one User Data directory
- ❌ substituting Chromium / Chrome for Testing / a headless browser for a real
  profile when the point of the test is a real send
- ❌ creating a throwaway WhatsApp profile on your own initiative just to run a
  test

> This is the most expensive rule in this repository's history: three temporary
> profiles were once created for CDP, and all three were dropped by the server
> within about two weeks for reasons 1 and 2 above. Every one of them ended on
> the QR screen and none was recovered.

**There is a direct consequence**: if a developer has exactly one signed-in
WhatsApp profile and it happens to live under the default User Data directory,
then that profile can **never** be driven over CDP. Path C in §4 exists for
that case.

### 2.1 The installed Chrome will not even load the extension

Separate from the debugging port, and just as absolute: the stable **Google
Chrome** build (137 and later) refuses `--load-extension` outright. It prints

```
--load-extension is not allowed in Google Chrome, ignoring
```

and starts with no extension loaded at all — which looks exactly like a broken
extension, or like a test that failed for no reason.

The browser-driving tools therefore use **Chrome for Testing**, resolved through
`tools/browser.js` (`findBrowser()`), and overridable with the `CHROME_BIN`
environment variable. `assertCanLoadExtensions()` refuses to drive a stable
Google Chrome binary rather than let a run fail confusingly.

Never work around this by cloning or copying a real browser profile.

### 2.2 The sanctioned way to get a clean browser

`tools/shoot.js` and `tools/verify-release.js` start Chrome on a **throwaway
`--user-data-dir`** (a fresh temp directory) and delete it afterwards. That is
the sanctioned way to get a clean browser: empty storage, no WhatsApp login,
nothing real to leak.

This is **not** the same thing as cloning the profile you use. Nothing is copied
out of your profile, nothing is copied into the throwaway one, and the profile
you use is never opened, duplicated or touched. See §3.

---

## 3. Red lines

1. **Do not close, restart or clean up a browser in use without consent.**
   That includes `kill`, `pkill` and AppleScript `quit`. If a restart is
   genuinely needed, explain why and get agreement first.
2. **Do not delete or rebuild WhatsApp's IndexedDB / Local Storage / Cookies.**
3. **Do not start two browser instances that share one User Data directory.**
4. **Do not affect an existing WhatsApp login state in order to test.**
5. **If a WhatsApp re-login is genuinely required, explain why and get
   confirmation first.** Do not ask for a QR scan out of the blue.
6. **Do not send any test content to a real customer.** Test sends go only to a
   test account you control.
7. **Do not print sensitive information**: API keys, `Authorization` headers,
   tokens, database passwords, SSH keys, `.env` contents. Report status only
   (`FOUND` / `MISSING` / `VALID` / `INVALID`). This applies to logs, test
   reports, error messages and the side panel's status line alike.

One addition: `pkill -f 'user-data-dir=...'` does not wait for the process to
exit. Before any restart, confirm the old process is **actually gone** (`ps`
shows nothing), then start the new one.

---

## 4. The four verification paths

| Path | Needs a browser? | Needs CDP? | Use it for |
|---|---|---|---|
| **A. Offline logic tests** | no | no | Pure functions, constants, protocol contracts. `node tools/test-safety.js` — 293 assertions |
| **B. Manual real-browser testing** | ✅ the daily profile | no | Real clicks, real sends, login-state questions. A human operates; an agent reads `chrome.storage.local` / extension page state / logs |
| **C. Test-bridge automation** | ✅ the daily profile | **no** | Driving the panel DOM, capturing outgoing request bodies, batch assertions |
| **D. Release verification** | ✅ a throwaway profile | no | Does the artefact we are about to publish actually install? `node tools/verify-release.js <zip>` — 16 assertions, run before every release |

**Path C needs no CDP.** It is this repository's positive answer to the
constraint in §2: rather than build a second profile for a debugging port (and
break the first profile's login state in the process), the extension carries its
own test channel.

### 4.1 How the test bridge works

```
Node test script  ──HTTP──▶  tools/bridge-server.js  ◀──long poll──  src/test/bridge.html
   (assertions)              (command queue, 127.0.0.1 only)          (runs in the browser)
                                                                          │
                                          ┌───────────────────────────────┴──────────────┐
                                          ▼                                              ▼
                              panel realm: the real side panel           self realm: the bridge page,
                              in an iframe, with the probe               which can import the extension's
                              injected into its own scope                modules and wrap fetch
```

Three realms together cover everything the old CDP harnesses could do:

| realm | what it is | what it can do |
|---|---|---|
| `panel` | the **real** `sidepanel.html` loaded in an iframe | click, type, read computed styles, read `chrome.storage`, call the panel's own functions |
| `self` | the bridge page itself | `import()` the extension's modules, wrap `fetch` to capture outgoing request bodies |
| `wa` | the WhatsApp tab, through `chrome.scripting` | read the page DOM (message count, composer contents) |

Two design points to read before changing this tooling:

- The probe is an **injected script file** (`src/test/panel-probe.classic.js`),
  not an `eval` string. The extension's CSP is `script-src 'self'`, so string
  evaluation is refused — and adding `unsafe-eval` to the manifest for a test
  tool would be the wrong trade. A classic script also shares the panel's global
  lexical scope, which is the only way to reach variables like `insOpen` that
  are not properties of `window`.
- The bridge page must **stay open** and must live in the **signed-in profile**.
  It is not resident: a test script starts its own server and shuts it down when
  it exits, and the page reconnects automatically the next time.

### 4.2 First connection

This only has to be done once:

1. In your daily profile, open (replace `<extension-id>` with the value
   `node tools/compute-extension-id.js` prints):

   ```
   chrome-extension://<extension-id>/src/test/bridge.html
   ```

2. Click **Connect to the test server** on the page and allow
   `http://localhost/*` in Chrome's permission prompt.

That origin is already in `manifest.json`'s `optional_host_permissions`, and the
grant **persists in that profile**, so it never has to be clicked again.

It is optional rather than a required `host_permission` for two reasons. First,
nothing in the shipped extension needs an optional host grant to work: the only
code that calls `chrome.permissions.request` is this bridge. Second, it is not a
permission that exists *only* for testing — `https://*/*` and `http://localhost/*`
are what a user's own AI provider needs, including a model server running on
their own machine, and the manifest states them once for both purposes. The
earlier note here claimed the published manifest carried no test-only
permission; that was wrong while `http://127.0.0.1/*` was still listed beside
`http://localhost/*`. That redundant second loopback pattern is gone, and this
page now uses `localhost` too.

After that:

```
node tools/bridge-server.js            # optional: run the server by hand and watch
node tools/test-instruction-panel.js   # 31 assertions
node tools/test-first-run.js           # 34 assertions
node tools/test-instruction-ai-path.js # 18 assertions, and it really calls the model
```

Each script starts its own server. When no bridge page is connected it says so
plainly ("no bridge page connected") instead of hanging.

Re-run the bridge tab after every reload:

```
node tools/open-bridge.js
```

`tools/open-bridge.js` closes any stale bridge tab and opens exactly one fresh
one. It **must be re-run after every `chrome.runtime.reload()`**, because the
reload closes the bridge tab — and Chrome serves the page's scripts from the
copy it cached at load time, so an un-reloaded tab keeps running old code. It is
also how you get out of the two-tab state, where the server hands each command
to whichever page polls first and results start depending on timing. It talks to
Chrome through AppleScript, matches tabs by URL only, and never touches another
tab, window or profile.

`tools/test-instruction-ai-path.js` makes two **real, paid** calls to the
configured model. It is not part of the routine loop — run it when prompt
assembly changes.

### 4.3 If you really do need CDP

`tools/cdp.js`, `tools/ext-test.js`, `tools/dom-test.js` and
`tools/reload-extension.js` still work, but they **can only point at a
non-default User Data directory**. `tools/reload-extension.js` requires
`--profile-dir` and refuses the default one; that is deliberate, because
silently falling back to a forbidden profile is worse than failing outright.

`tools/test-instruction-panel.js`, `tools/test-first-run.js` and
`tools/test-instruction-ai-path.js` have moved from CDP to the test bridge and
no longer need a debugging port.

### 4.4 The rest of the tooling

| Tool | What it does |
|---|---|
| `node tools/build-classic.js` | Regenerates the `*.classic.js` copies from the ES modules. `--check` verifies them without writing, and fails if a copy is stale. **Run it after every edit to a shared module** — see §5. |
| `node tools/shoot.js` | Documentation screenshots of the real panel, on a throwaway profile |
| `node tools/build-release.js` | Builds the release ZIP (`manifest.json` plus `src/`, minus `src/test/`), and refuses to build if the manifest names a file that is not there |
| `node tools/verify-release.js` | Loads the built ZIP into a throwaway profile and checks that Chrome accepts it, the service worker starts and the panel boots |

`tools/shoot.js` and `tools/verify-release.js` are the two tools that start a
browser on a throwaway `--user-data-dir`, as described in §2.2.

---

## 5. What the tests must never do to a real profile

The profile the bridge runs in is the profile a salesperson uses, and it holds
real customer conversations. A test that passes by damaging it is not a passing
test. Three rules:

1. **A test must never send a real message.** In particular it must never click
   the button that writes and sends without showing you the text first
   (`#btn-followup-go`). That the confirmation is a separate step is the whole
   point of it; a test that clicks through it defeats the only control standing
   between a stray click and a customer.
2. **A test must never clear a whole `chrome.storage` store.** Those stores hold
   the user's own per-chat instructions and drafts, which are not the test's to
   destroy. Remove only what the test itself created, with the probe's
   `dropChatKeys([...])` — it deletes exactly the synthetic chat ids a test
   invented, and nothing else.
3. **The panel harness must call `whenInitDone()` and then `detachChat()` before
   it pins anything.** This unhooks the panel from whatever real conversation
   the WhatsApp tab happens to have open, so the panel under test is looking at
   a synthetic context instead of a live customer's chat.

---

## 6. Environment requirements

| Item | Requirement |
|---|---|
| Chrome | 116 or later (`manifest.json`'s `minimum_chrome_version`) |
| Node | For the scripts under `tools/`; the bridge server uses only `node:http`, with no dependencies |
| Loading the extension | unpacked (`chrome://extensions` → Developer mode → Load unpacked) |
| AI configuration | After installing, enter the API key in the side panel's Settings; **no key is in this repository** |
| Browser for the driving tools | Chrome for Testing, found by `tools/browser.js`, overridable with `CHROME_BIN` (§2.1) |

`docs/DEVELOPMENT.md` records the versions and the observed limitation
behaviour that this tooling was written against.

---

## Change log

| Date | Version | Change |
|---|---|---|
| 2026-10-10 | v1.0 | First version: a single development profile locked down; Chrome 154's CDP restriction recorded; red lines and three verification paths established |
| 2026-10-10 | v2.0 | Open-sourcing: personal profile and environment details removed; path C changed from "a separate CDP profile" to the **test bridge** (no CDP, no second profile, no re-scanning the QR code); "if you really do need CDP" added |
| 2026-10-11 | v3.0 | Public-release rewrite in English: the product is now **WhatsApp Sales AI Copilot**; path A is 293 assertions; path C gained `tools/test-first-run.js` and `tools/open-bridge.js`; Chrome 137+ refusing `--load-extension` (and Chrome for Testing through `tools/browser.js`) documented; the throwaway-profile tools distinguished from profile cloning; §5 added — what the tests must never do to a real profile |
| 2026-10-11 | v3.1 | Added path D, release verification (`tools/verify-release.js`), and the `tools/build-release.js` / `tools/shoot.js` rows in §4.4; path C's run list now names `tools/test-first-run.js` |
