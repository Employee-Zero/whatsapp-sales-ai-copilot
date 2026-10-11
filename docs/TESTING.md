# Testing

How this project is verified. `AGENTS.md` §3 and §4 are authoritative for the
safety rules and for what each verification path is for; this document describes
what the tests actually cover, what they cost, and what they cannot reach.

Summary of the automated entry points:

| Command | Needs a browser | Needs a configured AI key | Assertions |
|---|---|---|---|
| `node tools/test-safety.js` | no | no | 345 |
| `node tools/test-helper.js` | no | no | 264 |
| `node tools/test-instruction-panel.js` | yes, through the test bridge | no | 31 |
| `node tools/test-first-run.js` | yes, through the test bridge | no | 34 |
| `node tools/verify-release.js <zip>` | yes, a throwaway profile | no | 35 |
| `node tools/test-instruction-ai-path.js` | yes, through the test bridge | yes, and it spends money | 18 |

All of them use the same reporting convention: one line per assertion, then a
`PASS: n   FAIL: n` summary, and a non-zero exit code if anything failed. The
first two need Node and nothing else: no browser, no profile, no account, no
network.

`tools/verify-release.js` is the odd one out: it does not drive the panel
through the bridge. It unzips both release archives, installs the extension into
a fresh Chrome for Testing profile, asks Chrome itself whether the extension
loaded, enabled and started its service worker, and runs the helper out of its
own archive the way a user would run it.

---

## 1. Offline logic tests

```bash
node tools/test-safety.js
```

No Chrome, no network, no configuration. Measured on the current tree:

```
  PASS: 345   FAIL: 0
```

The script loads `src/shared/constants.classic.js` and
`src/shared/utils.classic.js` into a `vm` sandbox that mimics a browser classic
script's global scope, and asserts against pure functions and constants only.
Note that it reads the **classic copies**, not the modules — so a stale copy is
what gets tested. `node tools/build-classic.js --check` is what catches that.

What it covers, in the order the script prints it:

| Section | Subject |
|---|---|
| [1] | `normalizePhone` — every format WhatsApp actually renders: spaces, non-breaking spaces, bidi marks, dashes, parentheses, `00` prefixes, national trunk zeros, and the length bounds that decide what is not a phone number at all |
| [2] | `phoneFromDisplayName` — a chat title counts as a number only if it *is* one; saved contact names, group subjects and digit-bearing words must never become one |
| [3] | `maskPhone` — logging must not leak a full number |
| [4] | the error codes the panel maps to user-facing text |
| [5] | `mergeConfig` — stray storage keys cannot inject fields |
| [6] | constants sanity |
| [7] | `resolveChatEndpoint` — every Base URL shape a user may paste |
| [8] | defaults — no provider, no model, no key shipped |
| [8b] | `hasRequiredConfig` — what "not set up yet" means |
| [9] | fallback eligibility — only connectivity failures may switch hosts |
| [10] | `describeHttpFailure` — the message must name the real problem |
| [11] | `classifyNetworkError` — a `fetch` `TypeError` is a connectivity failure |
| [12] | `directionFromGaps` — the comparison that was once inverted |
| [13] | message-direction constants |
| [14] | `resolveMaxTokens` — the automatic budget, including the case that used to produce empty replies |
| [15] | `thinkingRequestParam` — the field must be omitted entirely on `auto` |
| [16] | reply-length levels are defined by purpose and a word ceiling, not by sentence counts |
| [17] | `describeTextLength` / `measureText` — words, not characters |
| [18] | `formatPhoneDisplay` — always the full international form |
| [19] | `mergeMessageWindows` — the accumulated message count must only ever grow |
| [20] | `limitMessages` — the "last N" context option |
| [21] | `formatTranscript` — the ME / CUSTOMER labels |
| [22] | the shipped default system prompt: present, non-empty, editable |
| [22b], [22c] | migrating the pre-publish prompt, and never migrating the connection fields |
| [23] | `migrateStoredConfig` — an old stored default must not survive an upgrade |
| [24] | config schema — every field is typed and bounded |
| [25] | the worker → panel context contract |
| [26] | the per-chat instruction: the prompt contract (appended, after the general guidance, cannot override the no-invention rules, never sent as message text) and the panel wiring, checked by grepping the panel and worker sources for the call structure that keeps it correct |
| [27] | an unconfigured install makes no request — `missingAiFields` / `hasRequiredConfig`, plus the greps that no `sk-` prefix is demanded anywhere, that `generateReply` refuses before it builds a request, and that the worker checks configuration before it reads the chat |
| [28] | two connection methods — `connectionModeOf` reads a config written before the feature existed as the API-key method, each method demands only its own fields, both methods' values reach the panel and come back from its form, the new defaults, the loopback helper address, the scope set and the error codes the panel renders, and the greps that neither the panel nor the worker nor the shared layer holds a token field |

Sections [25] to [28] are static checks over source text as well as behaviour.
They constrain the shape of the wiring — for example that both generate paths
flush the instruction box before calling the worker, that a single function
moves both per-chat boxes, and that the panel reads the whole settings form
rather than only the method it is on — because those are the mistakes that a
functional test would only catch by accident.

Section [28] is what keeps the second connection method from being paid for by
the first. It asserts that an upgrade is not a migration: the config version is
still the one the API-key installs wrote, an old complete config still reports
ready, and the subscription path asks for a model and nothing else. It also
asserts the architectural claim the whole design rests on — that no credential
ever enters the extension — by grepping every layer of `src/` for token and
secret field names, and that `launchWebAuthFlow` is never called, since the
redirect this flow needs is a loopback HTTP listener and not `chromiumapp.org`.

---

## 2. Panel tests over the test bridge

```bash
node tools/open-bridge.js                # one fresh bridge tab, no stale ones
node tools/test-instruction-panel.js
```

31 assertions. Requires the test bridge (see `docs/DEVELOPMENT.md` §7): a bridge
page open in a Chrome profile that has the extension loaded. It does **not**
require a configured provider and makes no network calls, so it is the cheapest
test that exercises the real panel.

It loads the real `sidepanel.html` — same HTML, same CSS, same controller — in
the bridge's iframe and drives it through the injected probe. Clicks, typing,
`chrome.storage`, computed colours and measured heights are all real. Only the
chat context is supplied directly, because the bridge page has no WhatsApp
conversation to read; the test pins a synthetic context per chat id.

Three things keep it from touching a real person's data. It waits for the
panel's `init()` to finish, then **detaches** the panel from whatever
conversation the profile has open — otherwise the panel would boot bound to a
real customer, load their stored instruction into the box the first assertion
reads, and flush an empty reply box over a half-written draft. It then drops
only the two synthetic chat ids the test invents, never a whole store, and drops
the panel's own copy of those stores with them so a rerun on a dirty profile
starts clean.

The assertions cover the three visual states of the per-chat instruction box
(empty add-row, open editor, collapsed chip), the amber colour rules, focus and
caret behaviour, the 1000-character limit, storage writes for two different chat
ids, per-chat isolation when switching chats, deletion, and the guarantee that
writing an instruction never touches the reply box.

---

## 3. First-run tests over the test bridge

```bash
node tools/open-bridge.js
node tools/test-first-run.js
```

34 assertions, and the only suite written from a first-time user's point of
view rather than a developer's. It opens the real panel on an install that has
no provider configured and checks what that person actually sees:

- the welcome screen is up and the quickstart and settings panes are behind it;
- the three required fields are listed, a key is never rendered back into the
  field, and the placeholder is a neutral prompt rather than a key-shaped
  example;
- the error text for an unconfigured install names the missing fields, does not
  say "something went wrong", and does not print an internal error code;
- after connecting, the "what to do next" card appears once, "Got it" dismisses
  it, and the dismissal survives a re-render;
- the follow-up confirmation opens, names the recipient, closes on Cancel, and
  is dropped when the chat changes or the panel detaches;
- an empty reply box cannot be sent, a sent draft is not left behind, and an
  unsent draft for another chat is;
- drafts and instructions stay separated across three chat ids.

It overrides the panel's configuration through the probe rather than editing the
stored one, and restores the original configuration and onboarding flags before
it exits, so running it does not consume your own first-run. It walks the
API-key method; the welcome screen's switch between the two methods is asserted
by `tools/verify-release.js` (§4) rather than here.

---

## 4. Release verification

```bash
node tools/build-release.js
node tools/verify-release.js dist/whatsapp-sales-ai-copilot-0.2.0.zip
```

Run it with no argument and it builds both archives first. Give it a path and it
expects the helper archive to sit beside the one you named, as
`whatsapp-sales-ai-copilot-helper-<version>.zip`; that is what
`tools/build-release.js` writes.

35 assertions. It unzips each archive to a temporary directory, and installs the
extension into a throwaway Chrome for Testing profile with a temporary
user-data-dir — never the profile anyone sells from. It then asks Chrome's own
extension API whether the result is installed, enabled, at the version the
manifest claims, and free of manifest errors and warnings; reads the extension
id off the running service worker to prove the worker started; and finally opens
the panel page and confirms it boots to the welcome screen rather than to a
half-rendered reply UI.

The ZIP's contents are asserted too: the manifest is at the root, and `tools/`,
`src/test/`, `.git/` and the documentation are all absent. That is the check
that stops the test bridge, the build scripts or a Git history from being
published as part of the extension.

The helper archive is checked the same way, and then run. It must contain the
entry point, the `lib/` modules, `package.json` and its README; every entry must
keep the `helper/` prefix, so that extracting it next to the extension produces
exactly the path the panel tells the user to run; and it must contain no
`node_modules` and no credential file. The archive is then extracted and the
helper is run out of it, as a user would run it, with `WHATSAPP_COPILOT_HOME`
pointed at a throwaway directory: `--status` must answer with its own version,
report nobody signed in, and name a credential file that does not exist yet —
and must not create one by looking. `--help` must document `--port`, `--status`
and `--sign-out`. The helper's own default port is then read out of its archive
and compared with the extension's default helper URL, because two halves that
disagree about the address cannot find each other.

The welcome screen is asserted on the packaged panel page itself: both methods
are offered, the key method is the one selected by default, exactly one pane is
open, the subscription pane is wired rather than merely present, the header
shows a connection state, and switching to the subscription method and back
opens the right pane each time.

---

## 5. AI-path test

```bash
node tools/test-instruction-ai-path.js
```

18 assertions when both calls succeed; fewer run if a call fails, since the
body-level assertions are skipped when there is no captured body. Requires the
test bridge, **a configured provider, and a valid API key**.

> **This test makes two real calls to the configured model and costs real
> money.** It is not part of the routine loop; run it when the prompt assembly
> changes. It sends no message to anyone — the calls are generation-only — but
> the transcript it sends is a synthetic one written in the test file, not
> anything read from a browser.

It imports the extension's own `generateReply` into the bridge page's realm, so
nothing reimplements the prompt assembly, and wraps `fetch` for the duration of
the call to read the outgoing request body. The `Authorization` header is never
read, returned, printed or stored, and one assertion checks that no key-shaped
string appears in any captured body. Request bodies are summarised by length and
prefix, never printed whole, because a body is a customer conversation.

It asserts that exactly two messages go out; that the instruction is present in
the system message, labelled as an instruction, positioned after the general
guidance, and accompanied by the sentence that keeps it from overriding the
no-invention rules; that the instruction does **not** appear in the user
message; that the base system prompt is byte-identical up to the appended block;
and that the customer transcript does not leak into the system message.

---

## 6. Helper tests (the ChatGPT subscription path)

```bash
node tools/test-helper.js
```

264 assertions, and the other offline suite — the helper's rather than the
extension's, since the helper is a second component rather than part of the
extension. It needs Node and nothing else: no Chrome, no test bridge, no browser
profile, no account, no credential file and no internet access. It is a CommonJS
script that reaches the helper's ES modules with a dynamic `import()`, so it runs
on the same Node the helper does — 20 or later, which is what
`helper/package.json` declares.

Measured on the current tree:

```
  PASS: 264   FAIL: 0
```

Where the suite has to write a credential file it points
`WHATSAPP_COPILOT_HOME` at a temporary directory, so the file on your own
machine is never read, written or replaced. One section opens a real HTTP server
on an ephemeral `127.0.0.1` port; nothing leaves the machine.

What it covers, in the order the script prints it:

| Section | Subject |
|---|---|
| [1] | PKCE — the verifier's length and alphabet, the S256 challenge recomputed from it, and base64url's `-` and `_` rather than base64's `+` and `/` |
| [2] | SSE parsing — the same frames re-split at **every** byte offset, character by character, a CRLF straddling a chunk boundary, comment lines, and a `data:` field continued across several lines |
| [3] | frame classification — `response.completed` is the only success signal, `response.failed`, `response.incomplete` and `error` are failures, an unrecognised event is passed through rather than dropped, unparseable data is reported as such and truncated rather than echoed whole — and how the reply text is read out of the finished response |
| [4] | `buildResponsesBody()` — the exact five-key body, and the **18** ordinary Responses parameters that must never appear in it, because sending one back is the documented cause of the plan-rejection error; plus `clampTimeout`'s floor and ceiling, and that `helper/lib/responses.js` names no ChatGPT-internal endpoint once its comments are stripped and no absolute URL in it is off `api.openai.com` |
| [5] | inference against a stubbed `fetch` — a complete stream, a stream that stops early and must fail rather than show half a sentence, deltas that never add up to a completion, a mid-stream error frame, a completed-but-empty reply, HTTP 401 and 429, that the token travels in the `Authorization` header while appearing in neither the body nor the URL, and that the model list keeps only what the account may use |
| [6] | loopback guards — the `Host` header, the `Origin` header, a JSON content type, `OPTIONS`, and that no CORS header is ever emitted |
| [7] | the credential file — `0600` and `0700` modes, a round trip, no `.tmp` left behind, redaction, a corrupt store reported rather than silently replaced, and deletion |
| [8] | the authorization URL — every parameter present, `prompt=consent`, and no registration hint on a re-authorisation |
| [9] | the callback's parameters, including the issued client id whose name is not documented — so the parser scans for it rather than trusting one spelling |
| [10] | ID-token validation against a **real** RSA keypair generated by the test and a stubbed JWKS and discovery document: a tampered signature, claims swapped under a valid signature, `alg: none`, HS256, and a wrong `iss`, `aud`, `exp` or `nonce` |
| [11] | provider error mapping, including the bare `{detail}` shape, and that a provider's message is carried as detail rather than becoming the line the user reads |
| [12] | cross-checks — the two halves agree on the scopes, the resource and the default helper URL; the helper's error names and the extension's `ERR` values are compared in **both** directions, including the one deliberate difference in spelling and the extension's allow-list of helper codes; the helper's version matches the manifest's and its `package.json`'s; it is an ES module with no dependencies and a Node floor; and that no helper source file imports anything from `src/` |
| [13] | the two halves over real HTTP — the helper's real request handler on an ephemeral port, driven by the extension's real `src/ai/chatgpt-client.js`: the status a signed-out install reports, the sign-in handshake's URL, refusals for a page's origin, a CORS preflight and a non-JSON body, and that no status payload carries a token |

What a green run does not prove, and this is the important part:

- **Nothing signs in.** There is no browser in the loop and no account, so the
  part of the flow the user actually performs — the tab at `openai.com`, the
  consent, the callback arriving — is not exercised here at all. Whether a real
  sign-in completes is a manual check against a real account.
- **Nothing calls OpenAI.** Every request goes to a stubbed `fetch`, so what is
  proven is the request the helper would have put on the wire, not that the
  service accepts it. A change on OpenAI's side would not fail this suite.
- **The keypair is the test's own.** Section [10] generates the RSA key and the
  JWKS document it validates against, so it proves the validator's rules, not
  what the real discovery document publishes today.
- **The CLI is only partly covered.** `tools/verify-release.js` (§4) runs
  `--status` and `--help` from the packaged archive. `--print-authorize-url`,
  `--sign-out` and the sign-in itself are not driven by any automated test.
- **The panel's rendering of these failures is not covered here.** That the
  welcome screen offers both methods is checked by `tools/verify-release.js`
  (§4); the wording of each connection error is a manual check.

---

## 7. Documentation screenshots

```bash
node tools/shoot.js                     # every scene, into docs/assets
node tools/shoot.js --only chatgpt      # one scene
```

A capture, not a test: it renders the real side panel, in an iframe, on a
throwaway Chrome profile (`AGENTS.md` §2.2), and photographs it. The scene list
is in `tools/shoot.js`; the scenes themselves are in `src/test/shots.js`. The
conversation, the contact and the phone number are invented, down to using the
reserved `555-01xx` range, so a documentation page cannot contain a real
customer. It fails loudly if a scene does not settle, and that is all it
asserts — whether the rendering is *correct* is `tools/verify-release.js`'s job.

Three scenes cover the subscription method:

| Scene | File | What it shows |
|---|---|---|
| `chatgpt` | `08-chatgpt-helper-off.png` | the method with no helper running |
| `chatgptConnected` | `09-chatgpt-connected.png` | the same card with a plan connected and a model chosen |
| `settingsChatgpt` | `10-settings-chatgpt.png` | the subscription pane in Settings |

The first of those is not a staged state. In that throwaway profile nothing is
listening on `127.0.0.1`, the worker's own status request fails, and the panel
says the helper is not running because it genuinely is not.

The connected scene cannot be photographed that way, so the probe supplies the
values and the panel supplies everything else. `overrideChatGptStatus(status,
models)` in `src/test/panel-probe.classic.js` sets the status object and the
model list the panel would have received and then calls the panel's own render
functions for the card and the header. What the picture shows is therefore the
panel's real markup and wording, driven by numbers rather than by an account —
which is the point: a screenshot of a connected subscription must not require a
real sign-in, must not require a token to exist, and must not publish somebody's
plan. The model names in the scene are placeholders for the same reason, and the
account label is an `example.com` address.

---

## 8. Rules that must never be broken while testing

These come from `AGENTS.md` §2 and §3; they apply to every path above, including
the manual one.

- **Never copy a browser profile.** Moving profile data to a second directory to
  obtain a debuggable session puts the same WhatsApp linked-device credentials in
  two sessions at once. The server honours the later one and invalidates the
  earlier, which is how a working login is lost for good.
- **Never create a second profile to get a debug port.** A fresh profile means a
  fresh QR scan, and the original session is put at risk.
- **Never run two Chrome instances on the same user-data-dir.** Chrome does not
  support it, and the profile's own state can be damaged.
- **Never send test messages to real customers.** Test sends go only to an
  account you control. If no signed-in session is available, stop and report
  `BLOCKED: no logged-in Chrome session available` — do not substitute another
  browser to keep testing sends.
- **Never print API keys or customer data.** No keys, tokens or `Authorization`
  headers in logs, reports, error messages or the panel status line; report
  status only (`FOUND` / `MISSING` / `VALID` / `INVALID`). No real phone numbers,
  names or chat excerpts in a report, a commit, an issue or a screenshot. The
  helper's credential file is the same kind of secret: `--status` may report
  whether it exists and whether it is readable only by its owner, never what is
  in it, and no test may point `WHATSAPP_COPILOT_HOME` at the real one.
- Do not close, restart or clean up a browser that is in use without asking
  first, and never delete or rebuild WhatsApp's IndexedDB, Local Storage or
  cookies.
- The test bridge needs a **non-default** profile to be pointless and a
  **default** one to work: the bridge is designed precisely so no debugging port
  and no second profile is needed. Do not "fix" a bridge failure by reaching for
  CDP.

---

## 9. Known limits of the automated run

- **The panel follows a live WhatsApp tab.** In normal operation the side panel
  polls the content script for the currently open chat, so what it displays
  depends on what the browser is showing. Any test that needs a deterministic
  chat context must pin one through the bridge probe (`pinContext`) and silence
  the poll (`silencePoll`), as the panel test does. Without that, a test result
  depends on which conversation happens to be open.
- **The bridge tests do not read the real WhatsApp DOM.** The `wa` realm exists
  and can read the page, but the panel assertions run against an injected
  context. Verifying what the adapter makes of an actual conversation is a manual
  real-browser job.
- **The full panel → worker → provider round trip with a real chat is not
  automated.** The AI-path test calls `generateReply` directly with a synthetic
  transcript and a pinned instruction, which covers the prompt assembly and the
  request body. The worker's own read of the per-chat instruction store into that
  call is covered by the offline contract tests in section [25]/[26], not end to
  end, because that needs a signed-in WhatsApp session.
- **`node tools/test-safety.js` tests the generated classic copies, not the
  modules.** Run `node tools/build-classic.js --check` as well, or the offline
  suite can pass while the shipped pages are broken.
- **Nothing here verifies a send.** The send path has two independent gates, and
  the only way to be sure about it is a manual real-browser run against a test
  account.
- **`node tools/test-instruction-ai-path.js` results are model-dependent.** The
  assertions are about the request the extension builds, not about the wording of
  the reply, so a model change does not break them — but a provider change that
  alters the body shape will.
- **Nothing here proves that a ChatGPT subscription works.** `node
  tools/test-helper.js` (§6) stubs `fetch` and never signs in, and
  `tools/verify-release.js` (§4) runs the packaged helper but stops short of a
  sign-in. What is covered is the request the helper builds, the credential
  file's handling, the loopback guards, the ID-token validation and the error
  mapping — all against a stub or a throwaway directory. Whether OpenAI accepts
  the request, whether an account turns out to be eligible, and whether a reply
  comes back are manual checks against a real account.
- **`node tools/test-helper.js` never drives the helper's CLI beyond `--status`
  and `--help`.** `--print-authorize-url` and `--sign-out` are documented in
  `helper/README.md` and are exercised by no automated path: a change to either
  can pass every suite here.
