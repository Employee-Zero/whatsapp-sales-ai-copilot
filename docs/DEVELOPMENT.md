# Development

Developer guide for the WhatsApp Sales AI Copilot extension.

`AGENTS.md` is the authoritative rules file (what must be done, and what is
forbidden). This document explains how the pieces fit together and how to build,
load and ship them. For the module-level design see `docs/ARCHITECTURE.md`; for
the environment facts and measured limits see `docs/DEVELOPMENT.md` (section 2).

---

## 1. Requirements

| Item | Requirement |
|---|---|
| Chrome | 116 or newer. `manifest.json` sets `"minimum_chrome_version": "116"` |
| Node.js | Only to run the scripts in `tools/`. There is no `package.json`, no `node_modules`, and no npm dependency anywhere in the repository |
| Extension install | unpacked, from `chrome://extensions` |
| AI provider | An OpenAI-compatible chat-completions endpoint, configured at runtime. The repository ships no key and no default provider |

Node built-ins used by `tools/`: `node:http`, `node:child_process`, `node:fs`,
`node:path`, `node:crypto`, `node:vm`, `node:os`. The CDP helpers in
`tools/cdp.js` additionally rely on the global `fetch` and the global
`WebSocket`, which Node only exposes from v22 onward. Everything on the test
bridge path works on much older Node; only the CDP path needs v22+.

### Load unpacked

```
chrome://extensions
  → enable Developer mode (top right)
  → Load unpacked
  → select the repository root
```

After editing extension code: press the extension's Reload button on
`chrome://extensions`, then refresh the WhatsApp Web tab. The content scripts
run at `document_start`, so a tab that was already open keeps the old ones.

### Where the extension id comes from

Chrome derives the id of an unpacked extension from the SHA-256 of its absolute
path. Because the path is machine-specific, so is the id — and so is any
`chrome-extension://<id>/...` URL. Compute it rather than copying one:

```
node tools/compute-extension-id.js            # the repository it lives in
node tools/compute-extension-id.js <path>     # any other directory
```

---

## 2. Repository layout

```
whatsapp-followup-extension/
├── manifest.json               MV3 manifest; the only entry point
├── src/
│   ├── background/
│   │   └── service-worker.js   orchestration, the send gate, the busy lock
│   ├── content/
│   │   ├── whatsapp-adapter.js all WhatsApp DOM reading and writing
│   │   └── content-script.js   message routing, chat identity guard, accumulator
│   ├── ai/
│   │   └── ai-client.js        request assembly, fallback, error classification
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.css
│   │   └── sidepanel.js        panel controller
│   ├── shared/
│   │   ├── constants.js        defaults, message types, error codes, limits
│   │   ├── constants.classic.js GENERATED — do not edit (see §3)
│   │   ├── utils.js            phone normalisation, endpoint resolution, merging
│   │   └── utils.classic.js    GENERATED — do not edit (see §3)
│   └── test/                   development only; not in the manifest (see §9)
│       ├── bridge.html
│       ├── bridge.js
│       ├── panel-probe.classic.js
│       ├── shots.html          screenshot harness
│       └── shots.js
├── tools/                      Node scripts; never shipped
├── docs/
│   ├── GETTING_STARTED.md      the salesperson's install guide
│   ├── ARCHITECTURE.md
│   ├── DEVELOPMENT.md          this file
│   ├── TESTING.md
│   ├── RELEASE_NOTES_v0.1.0.md the text of the GitHub Release
│   └── assets/                 screenshots of the real panel
├── .github/workflows/          release packaging on a version tag
└── dist/                       built ZIPs; git-ignored
```

There is no build step for `src/`. The extension loads these files as they are.

---

## 3. The `*.classic.js` copies — read this before editing a shared module

`src/shared/constants.js` and `src/shared/utils.js` are ES modules. The service
worker is loaded with `"type": "module"` and imports them; the content script
and the side panel are classic scripts and load generated copies with the module
syntax stripped:

- `manifest.json` → `content_scripts.js` lists `constants.classic.js` and
  `utils.classic.js`
- `src/sidepanel/sidepanel.html` → `<script src="../shared/constants.classic.js">`
  and `utils.classic.js`

A single `export` statement in a classic script aborts the whole file with
`Uncaught SyntaxError: Unexpected token 'export'`. Nothing in it runs, so every
constant it declares is `undefined` and the page fails **silently** — no error
reaches the service worker, and the panel simply stops working in ways that look
unrelated to the edit.

Therefore: **after editing a shared module, regenerate the copies.**

```bash
node tools/build-classic.js           # rewrite the copies
node tools/build-classic.js --check   # exit 1 if a copy is stale; writes nothing
```

`--check` exits non-zero the moment a copy does not match what the generator
would produce, which makes it usable as a pre-commit or CI gate.

Do not edit `*.classic.js` by hand; the generator overwrites it. It removes only
two things — top-level `import … from '…';` lines and the trailing `export { … }`
block — and copies everything else, comments included, verbatim.

---

## 4. How an AI request is built

A request is assembled from the stored configuration, the system prompt, the
per-chat instruction, the conversation transcript and the reply-length
guidance — and the token budget is derived from the last two settings rather
than configured directly.

**Configuration comes from `chrome.storage.local`, never from source.**
`loadAiConfig()` (`src/ai/ai-client.js`) reads the `aiConfig` key on every call,
runs `migrateStoredConfig()` on the raw stored object, then merges it over
`DEFAULT_AI_CONFIG` (`src/shared/constants.js`) and normalises it. Changing
Settings therefore takes effect on the next request, with no reload and no code
edit. The defaults for `primaryBaseUrl`, `fallbackBaseUrl`, `apiKey` and `model`
are empty strings, and `assertConfigured()` refuses to send anything until Base
URL, API Key and Model are all present — the panel shows a first-run screen
instead of issuing a doomed request. The key is stored in
`chrome.storage.local`, which follows the browser profile, not the repository.

**The request has exactly two messages.** `generateReply()` builds:

```js
[
  { role: 'system', content: systemPromptFor(cfg) + instructionBlock(ctx.instruction) },
  { role: 'user',   content: buildUserPrompt({ ...ctx, transcript }, cfg) },
]
```

- The **system message** is the editable general prompt (`cfg.systemPrompt`)
  with the **per-chat instruction** appended. It rides on the system message,
  after the general prompt, so that it outranks the general guidance — and
  `instructionBlock()` states that it cannot override the no-invention rules in
  the base prompt. The instruction is keyed by `chatId` in
  `chrome.storage.local.instructions`.
- The **user message** carries the contact name, the transcript, the current
  time, and the **length guidance** for the selected reply length
  (`REPLY_LENGTH_SPECS[cfg.replyLength].guidance`, e.g. "LENGTH: MEDIUM. One to
  three short sentences, at most about 60 words."). Length is a per-generation
  control, so its wording is appended here rather than being baked into the
  system prompt. The transcript is trimmed from the front to the
  `maxChars` ceiling, keeping the newest part, and the per-chat context window
  (`contextMessages`; `0` means everything accumulated) is applied before that.

**`max_tokens` is derived automatically when it is set to 0** — the default:

```
maxTokens > 0 ? clamp(maxTokens, 16, 8192)
              : clamp(REPLY_LENGTH_SPECS[replyLength].outputTokens
                       + THINKING_SPECS[thinking].reserveTokens, 16, 8192)
```

Medium + Auto is 1000 + 2048 = 3048. The `thinking` reserve exists because on a
reasoning model the thinking tokens are billed against `max_tokens`: a budget
smaller than the thinking needs is spent entirely on reasoning and the response
comes back with HTTP 200, no error, and no content. `generateReply()` treats an
empty body and `finish_reason: "length"` as the same failure and retries once
with `min(8192, max(budget * 3, budget + 1024))`. A reply that is still empty or
still truncated is raised as `AI_RETURNED_EMPTY` / `AI_REPLY_TRUNCATED` rather
than handed to the user as a draft.

The panel shows the derived value as `effectiveMaxTokens` in Settings, so the
number in effect is always visible and `0` never means "unknown".

**Transport** is one `POST` to `<base>/v1/chat/completions`, with
`thinkingRequestParam(mode)` added to the body only when the mode is not `auto`
(sending the field to a model that does not accept it is an HTTP 400). Only
connectivity failures — network errors, DNS, connection refused, TLS, connect
timeouts — switch to the fallback host. `401`, `403`, `404`, `429`,
`model_not_found` and `bad_request` do not: those are configuration errors, and
switching hosts would only hide them while doubling the latency.

---

## 5. The four verification paths

`AGENTS.md` §4 defines these. Use the cheapest one that can actually answer your
question.

| Path | Browser | CDP | Use it for |
|---|---|---|---|
| **A. Offline logic tests** | no | no | Pure functions, constants, protocol contracts, prompt contract, panel wiring greps. `node tools/test-safety.js` |
| **B. Manual real-browser** | yes, the profile you use daily | no | Real clicks, real sending, login-state questions, anything about how WhatsApp actually behaves |
| **C. Test bridge** | yes, the profile you use daily | no | Driving the real panel DOM, reading computed styles, capturing outgoing request bodies, batch assertions |
| **D. Release verification** | yes, a throwaway profile | no | Whether the artefact about to be published actually installs. `node tools/verify-release.js <zip>` |

Path A is the only one that is safe to run at any time and needs no setup; run it
before and after every change to shared logic. Path B is the only way to confirm
an actual send, and a human has to do the clicking. Path C is automated but still
runs against a real, signed-in browser, so it starts real requests and must never
be pointed at a real customer's chat.

`docs/TESTING.md` covers what each test covers, and the safety rules that apply
while running any of them.

---

## 6. Chrome's remote-debugging restriction

From Chrome 136 onward the restriction tightens, and from 154 it is total: on a
default user-data-dir Chrome refuses to open a remote-debugging port.

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

The test is the **path itself**. Passing `--user-data-dir` explicitly and
pointing it at the default directory is still refused. The process starts
normally; the port never listens and `DevToolsActivePort` is never written, so
the failure is silent unless you go looking for it.

Two consequences, and they do not reconcile with each other:

- Browsing with your signed-in WhatsApp session happens in the default profile.
- Anything driven over CDP must run against a **non-default** user-data-dir.

That is why the CDP helpers in `tools/` — `cdp.js`, `ext-test.js`, `dom-test.js`,
`reload-extension.js`, and `click.js` on top of them — can only ever talk to a
Chrome started with a non-default data directory. `tools/reload-extension.js`
enforces this explicitly: `--profile-dir` is required, has no default, and is
rejected with an error if it resolves to the default Chrome user-data-dir. The
other CDP scripts take no profile argument at all; they connect to
`http://127.0.0.1:9222` and simply fail if nothing is listening, which is what
happens when the only running Chrome is on the default profile. Failing loudly is
deliberate — a silent fallback onto a profile that cannot be debugged, or onto a
second profile holding the same WhatsApp session, is worse than an error.

What must not be done to work around this — copying profile data to a second
directory, running two Chrome processes on one user-data-dir, substituting a
headless or alternate browser for real sending, or creating a throwaway profile —
is listed in `AGENTS.md` §2. The reason is not style: WhatsApp Web's
linked-device credentials can be held by two sessions at once, and the server
honours the later one, invalidating the earlier. The test bridge in §7 exists so
that none of those workarounds are ever necessary.

---

## 7. The test bridge

The bridge gives Node scripts a command channel into a running Chrome without a
debugging port, and therefore without a second profile.

```
Node test script  ──HTTP──▶  tools/bridge-server.js  ◀──long poll──  src/test/bridge.html
   (assertions)              (queue on 127.0.0.1)                    (runs in the browser)
                                                                          │
                                          ┌───────────────────────────────┴──────────┐
                                          ▼                                          ▼
                              panel realm: the real side panel        self realm: the bridge
                              in an iframe, with the probe            page, importing the
                              injected into its own scope             extension's modules
```

Three realms are reachable:

| Realm | What it is | What it can do |
|---|---|---|
| `panel` | the real `sidepanel.html` in an iframe, with `src/test/panel-probe.classic.js` injected | click, type, read computed styles, read `chrome.storage`, call the panel's own functions |
| `self` | the bridge page itself | `import()` the extension's modules, wrap `fetch` to capture outgoing bodies |
| `wa` | the WhatsApp tab, through `chrome.scripting` | read page DOM |

The probe is injected as a **script file**, not an `eval` string: the extension's
CSP is `script-src 'self'` with no `unsafe-eval`, and adding `unsafe-eval` for a
test tool would be the wrong trade. A classic script also shares the panel's
global lexical scope, which is the only way to reach variables such as `insOpen`
that are not properties of `window`.

### One-time setup

1. Open the bridge page **in the profile that is already signed in to WhatsApp
   Web** (compute the id first if you have not):

   ```
   node tools/compute-extension-id.js
   chrome-extension://<id>/src/test/bridge.html
   ```

2. Press **Connect to the test server** on the page and allow
   `http://localhost/*` in Chrome's permission prompt.

That origin is already listed in `manifest.json` under
`optional_host_permissions`. The grant is stored in the profile and persists, so
this is done once. It is deliberately not a mandatory `host_permissions` entry,
because the only code in the repository that ever asks for it is this dev bridge.

Two things this section used to get wrong, both corrected here. It claimed the
published manifest carried no permission that exists only for testing — untrue
while `http://127.0.0.1/*` sat in `optional_host_permissions` next to
`http://localhost/*`. And it implied the bridge needed that loopback pattern
purely for itself. In fact `https://*/*` and `http://localhost/*` are there for
the product: a user pointing the extension at their own provider, or at a model
server on their own machine. There is now one loopback pattern, not two, and the
bridge uses the same one.

The page must stay open while a test runs. It is not a resident service — each
test script starts `tools/bridge-server.js` on `127.0.0.1:8787`, runs, and shuts
the server down when it exits; the page reconnects on the next run. Set
`BRIDGE_PORT` to use a different port, and `BRIDGE_WAIT_MS` to change how long a
script waits for the page before giving up. The server binds to the loopback
interface only, so the page reaches it as `http://localhost:8787`.

### Running a bridge test

```bash
node tools/build-classic.js             # the bridge loads the extension's own code
node tools/open-bridge.js               # close stale bridge tabs, open one fresh
node tools/test-instruction-panel.js    # 31 assertions
node tools/test-instruction-ai-path.js  # 18 assertions; makes real, billable AI calls
```

Both scripts start their own server. If no bridge page is connected they report
that explicitly rather than hanging.

`node tools/open-bridge.js` closes every tab whose URL is this extension's
bridge page and opens one fresh tab (macOS only; it drives Chrome through
AppleScript and touches no other tab, window or profile). Use it after editing
`bridge.js` or `panel-probe.classic.js`: Chrome serves the cached copy of a page
script, so an edit has no effect until the page reloads. It also prevents two
bridge tabs from being open at once — the server hands each command to whichever
page polls first, so a stale second tab makes results depend on timing.

To watch the channel by hand:

```bash
node tools/bridge-server.js   # holds the port open; Ctrl-C to stop
```

---

## 8. Releasing

```bash
node tools/build-classic.js --check   # the generated copies must match
node tools/test-safety.js             # offline tests must pass
node tools/build-release.js           # writes dist/
node tools/verify-release.js dist/whatsapp-sales-ai-copilot-0.1.0.zip
```

`tools/build-release.js` produces
`dist/whatsapp-sales-ai-copilot-<version>.zip`, taking the version from
`manifest.json`. The layout is:

```
whatsapp-sales-ai-copilot-<version>.zip
├── manifest.json          at the archive root, not in a subdirectory
└── src/                   everything under src/ except src/test/
```

Nothing else. The archive must be loadable as-is: unzip it, point **Load
unpacked** at the unzipped directory, and the extension loads and runs. That
means `manifest.json` has to sit at the top level of the archive, since Chrome
reads it from the directory root.

The build checks that rather than assuming it. Every file the manifest names
must be present, and nothing may be present that is not the manifest or under
`src/` — so a stray file fails the build instead of shipping quietly.

Excluded, and why:

| Excluded | Reason |
|---|---|
| `tools/` | Node scripts for development; the extension never loads them |
| `src/test/` | the dev bridge and the panel probe (see §9) |
| `docs/`, `AGENTS.md`, `README.md` | documentation, not extension code |
| `.git/` | the archive is built from the tree, never from a clone |

`tools/verify-release.js` is the check that matters before publishing. It
unzips the archive into a temporary directory, installs it into a **throwaway**
Chrome for Testing profile with its own `--user-data-dir`, and then asks
Chrome whether the extension is installed, enabled and at the right version,
whether it raised manifest errors or warnings, whether the service worker
started, and whether the side panel boots to the welcome screen. None of that
can be established by reading source.

`dist/` is git-ignored: the download lives on the Releases page, built from the
tag, not in the repository.

### Publishing

`.github/workflows/release.yml` builds the ZIP on a version tag and attaches it
to the Release with `gh release upload`. It re-runs `build-classic.js --check`
and the offline suite first, so a tag whose generated copies have drifted fails
instead of publishing a ZIP that was never built from the tree.

The workflow attaches to a Release that already exists. Create the Release for
the tag first, then push the tag — or run the workflow by hand and give it the
tag name.

---

## 9. Development-only files

`src/test/` as a whole is development-only. `manifest.json` references no file in
it, nothing under `src/` imports from it, and none of it is loaded by the running
extension — a person opens these pages by hand. That is what makes the directory
safe to leave out of the release archive.

`src/test/bridge.html` and `src/test/bridge.js` are the browser half of the test
bridge, and `src/test/panel-probe.classic.js` is the probe it injects into the
side panel.

`src/test/panel-probe.classic.js` is a classic script for the reason given in
§7: it has to share the panel's global lexical scope. It is not a generated
file, despite the matching suffix — only `src/shared/*.classic.js` are
generated.
