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
| Node.js | Only to run the scripts in `tools/`, and to run the local helper. The extension itself has no `package.json`, no `node_modules` and no npm dependency anywhere; the helper is its own package with an empty `dependencies` object and needs **Node 20 or newer** |
| Extension install | unpacked, from `chrome://extensions` |
| AI provider | An OpenAI-compatible chat-completions endpoint, configured at runtime, or the user's own ChatGPT plan through the local helper (§10). The repository ships no key and no default provider |

Node built-ins used by `tools/`: `node:http`, `node:child_process`, `node:fs`,
`node:path`, `node:crypto`, `node:vm`, `node:os`. The CDP helpers in
`tools/cdp.js` additionally rely on the global `fetch` and the global
`WebSocket`, which Node only exposes from v22 onward. Everything on the test
bridge path works on much older Node; only the CDP path needs v22+.

The helper uses `node:http`, `node:crypto`, `node:fs`, `node:os`, `node:path` and
`node:url`, and nothing outside the standard library. Its `engines.node` field
requires 20 or later, which is what `AbortSignal.any` needs.

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
│   │   ├── ai-client.js        request assembly, fallback, error classification
│   │   └── chatgpt-client.js   HTTP client for the local helper; holds no credential
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
├── helper/                     the local helper — a separate Node package (see §10); not extension code
│   ├── siwc-helper.js          HTTP server, OAuth sign-in, token lifecycle, CLI
│   ├── lib/                    guard, oauth, pkce, responses, store, errors, constants
│   ├── package.json            type: module, engines.node >= 20, no dependencies
│   └── README.md               the user-facing guide for this connection method
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
There is no build step for `helper/` either: it is plain ESM run by Node.

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

**The ChatGPT method shares everything above and changes only the last leg.**
`generateReply()` reads the config, applies the configuration gate, trims the
context window and assembles the same system prompt and the same user message;
then, when `connectionModeOf(cfg)` is `chatgpt`, it hands those two strings to
`chatgpt-client.js` instead of calling `callWithFallback()`. The helper receives
`{ model: cfg.chatgptModel, instructions, input, timeoutMs }` and puts them into
the Responses API's two fields (`docs/ARCHITECTURE.md` §14.7). Three
consequences are worth knowing before touching this code:

- `temperature` and the token ceiling are not sent, and cannot be. The flow
  rejects those parameters outright, so the panel labels both settings as
  applying to the API-key method and does not offer them on the ChatGPT pane.
- There is no retry with a larger budget on this path. The budget is not ours to
  raise, so a reply that comes back with no text is reported as
  `AI_RETURNED_EMPTY` rather than retried.
- The fallback host does not exist here either. There is one helper address, and
  a failure to reach it is reported as such.

---

## 5. The four verification paths

`AGENTS.md` §4 defines these. Use the cheapest one that can actually answer your
question.

| Path | Browser | CDP | Use it for |
|---|---|---|---|
| **A. Offline logic tests** | no | no | Pure functions, constants, protocol contracts, prompt contract, panel wiring greps. `node tools/test-safety.js` and `node tools/test-helper.js` |
| **B. Manual real-browser** | yes, the profile you use daily | no | Real clicks, real sending, login-state questions, anything about how WhatsApp actually behaves |
| **C. Test bridge** | yes, the profile you use daily | no | Driving the real panel DOM, reading computed styles, capturing outgoing request bodies, batch assertions |
| **D. Release verification** | yes, a throwaway profile | no | Whether the artefacts about to be published actually install and run. `node tools/verify-release.js <zip>` |

Path A is two suites. `node tools/test-safety.js` covers the extension — 345
assertions, and one of its sections asserts that the subscription path does not
disturb the API-key path. `node tools/test-helper.js` covers the helper — 264
assertions; §10 has what it exercises. Neither needs a browser, a ChatGPT account
or a request to anything outside the machine.

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
node tools/test-safety.js             # the extension's offline tests must pass
node tools/test-helper.js             # the helper's offline tests must pass
node tools/build-release.js           # writes both archives to dist/
node tools/verify-release.js dist/whatsapp-sales-ai-copilot-0.1.0.zip
```

`tools/build-release.js` produces two archives, because there are two things to
install. The extension takes its version from `manifest.json`:

```
whatsapp-sales-ai-copilot-<version>.zip          the extension
├── manifest.json          at the archive root, not in a subdirectory
└── src/                   everything under src/ except src/test/

whatsapp-sales-ai-copilot-helper-<version>.zip   the local helper (see §10)
└── helper/                siwc-helper.js, lib/, package.json, README.md
```

Nothing else in either. The extension archive must be loadable as-is: unzip it,
point **Load unpacked** at the unzipped directory, and the extension loads and
runs. That means `manifest.json` has to sit at the top level of the archive,
since Chrome reads it from the directory root.

The helper archive keeps the `helper/` prefix, so extracting it next to the
extension produces exactly the path the panel tells the user to run
(`node helper/siwc-helper.js`). It is a separate download on purpose: a Node
program has no place inside a browser extension's package, the API-key method
needs neither the download nor Node, and one combined archive would make everyone
pay for a feature most of them do not use.

The build checks both rather than assuming either. Every file the manifest names
must be present, and nothing may be present that is not the manifest or under
`src/` — so a stray file fails the build instead of shipping quietly. The helper
archive must contain its entry point and every library module beside it, since an
archive missing one extracts cleanly and then cannot be started.

Excluded from the extension archive, and why:

| Excluded | Reason |
|---|---|
| `tools/` | Node scripts for development; the extension never loads them |
| `src/test/` | the dev bridge and the panel probe (see §9) |
| `helper/` | the local helper is a Node program and ships as its own archive (§10) |
| `docs/`, `AGENTS.md`, `README.md` | documentation, not extension code |
| `.git/` | the archive is built from the tree, never from a clone |

`tools/verify-release.js` is the check that matters before publishing. It
unzips each archive into a temporary directory — the extension into a
**throwaway** Chrome for Testing profile with its own `--user-data-dir`, the
helper into a directory it then runs `node helper/siwc-helper.js --status` from,
with `WHATSAPP_COPILOT_HOME` pointed at an empty directory — and then asks
Chrome whether the extension is installed, enabled and at the right version,
whether it raised manifest errors or warnings, whether the service worker
started, and whether a fresh install boots to a welcome screen that offers both
connection methods with the API-key one selected. None of that can be
established by reading source.

`dist/` is git-ignored: the downloads live on the Releases page, built from the
tag, not in the repository.

### Publishing

`.github/workflows/release.yml` builds the archives on a version tag and attaches
them to the Release with `gh release upload dist/whatsapp-sales-ai-copilot-*.zip
--clobber`, which picks up both. It re-runs `build-classic.js --check` and the
offline suite first, so a tag whose generated copies have drifted fails instead
of publishing a ZIP that was never built from the tree.

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

---

## 10. The local helper

`helper/` is the second runnable component in this repository. It is a Node
program, not extension code: nothing under `src/` is packaged with it, and the
extension archive never contains it. Only the ChatGPT-subscription connection
method uses it (`docs/ARCHITECTURE.md` §14); the API-key method works with
nothing else installed.

It exists because the sign-in cannot be done from a browser extension. OpenAI's
sign-in for open-source and locally hosted apps accepts only an HTTP loopback
callback on `127.0.0.1`, at a fixed path with only the port free to vary;
`chrome.identity.launchWebAuthFlow` intercepts only
`https://<extension-id>.chromiumapp.org/*`, which is not an accepted redirect;
and an MV3 extension cannot open a listening socket. There is a second reason
that matters more: the documentation requires tokens to be kept out of browser
storage, so the credential lives in a file this process owns and the extension is
never given a token at all. `docs/ARCHITECTURE.md` §14.2 to §14.6 covers the
design; this section covers running, testing and shipping it.

### Running it

```
node helper/siwc-helper.js
```

Run it from the directory that contains `helper/` — the repository root, or the
directory the helper archive was extracted into. It prints the credential file it
will use, whether an account is already signed in, and the port it is listening
on.

| Flag | Effect |
|---|---|
| `--port <n>` | Port to listen on. Default `8788`, which is what `CHATGPT_HELPER_DEFAULT_URL` and the panel's Helper address field expect. Must be 1–65535 |
| `--status` | Print the connection state as JSON and exit. Does not start the server |
| `--sign-out` | Revoke the session with OpenAI and forget it locally, then exit |
| `--print-authorize-url` | Start the server, begin a sign-in and print the URL instead of waiting for the extension to ask. For a machine with no browser to hand |
| `--help` | Usage, including the credential file path for this machine |

An unknown option prints the usage and exits 2. A port that is already in use is
reported as a sentence naming the port, because the usual cause is a second copy
of the helper already running, and that is not something a stack trace explains.

The server binds `127.0.0.1` and nothing else — never the wildcard address — and
refuses any request whose `Host` header is not that address and this port, whose
`Origin` is a web origin, or that carries a non-JSON body. `node tools/test-helper.js`
covers each of those refusals.

### Where it keeps the credential

| Platform | Location |
|---|---|
| macOS / Linux | `~/.config/whatsapp-sales-ai-copilot/credentials.json` |
| Windows | `%APPDATA%\whatsapp-sales-ai-copilot\credentials.json` |

The directory is `0700` and the file `0600`, written atomically through a
temporary file and a `rename`. A missing file is normal and reads as an empty
store; a corrupt one is reported rather than replaced, since overwriting it would
destroy the only copy of a refresh token that may still be revocable.

`WHATSAPP_COPILOT_HOME` overrides the whole location. That variable exists for
testing, and it matters more than it looks: without it a test run would write
over a real sign-in and delete a real refresh token. `tools/test-helper.js` sets
it to a temporary directory, and `tools/verify-release.js` sets it when it runs
the helper out of the built archive.

### Running its tests

```
node tools/test-helper.js      # 264 assertions
```

No browser, no ChatGPT account, and nothing leaving the machine: every test
either calls a pure function directly or replaces `globalThis.fetch` with a stub
and inspects what would have gone on the wire. It imports the helper's own
modules from `helper/lib/`, so it cannot drift from the code it is checking.

What it covers: PKCE against the exact bytes that go on the wire, SSE frames
re-split at every offset and with CRLF, the inference request body's exact key
set (the subset is the contract — re-adding `temperature` is what produces a
`subscription_sharing_unsupported_capability` failure), a complete and a
truncated stream against a stubbed `fetch`, the loopback guards, the credential
file's modes and atomicity and its handling of a corrupt file, the authorize URL
parameter by parameter, callback parsing, ID-token validation against a real
generated RSA keypair, and the helper's duplicated constants against the
extension's in both directions.

Its last section drives both halves against each other over real HTTP: the
extension's `chatgpt-client.js` talking to the helper's own `createHandler()` on
an ephemeral loopback port. That is the one thing neither half's own tests can
check, and it is why the handler is exported as a factory.

There is no build step, no bundling and no dependency to install — `helper/package.json`
declares `"type": "module"`, `"engines": { "node": ">=20" }` and an empty
`dependencies` object. The helper version is kept equal to `manifest.json`'s
version, and the test asserts that it is.
