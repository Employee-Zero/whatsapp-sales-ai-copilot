# Testing

How this project is verified. `AGENTS.md` §3 and §4 are authoritative for the
safety rules and for what each verification path is for; this document describes
what the tests actually cover, what they cost, and what they cannot reach.

Summary of the automated entry points:

| Command | Needs a browser | Needs a configured AI key | Assertions |
|---|---|---|---|
| `node tools/test-safety.js` | no | no | 293 |
| `node tools/test-instruction-panel.js` | yes, through the test bridge | no | 31 |
| `node tools/test-first-run.js` | yes, through the test bridge | no | 34 |
| `node tools/verify-release.js <zip>` | yes, a throwaway profile | no | 16 |
| `node tools/test-instruction-ai-path.js` | yes, through the test bridge | yes, and it spends money | 18 |

All of them use the same reporting convention: one line per assertion, then a
`PASS: n   FAIL: n` summary, and a non-zero exit code if anything failed.

`tools/verify-release.js` is the odd one out: it does not drive the panel
through the bridge. It unzips the release artefact, installs it into a fresh
Chrome for Testing profile, and asks Chrome itself whether the extension loaded,
enabled and started its service worker.

---

## 1. Offline logic tests

```bash
node tools/test-safety.js
```

No Chrome, no network, no configuration. Measured on the current tree:

```
  PASS: 293   FAIL: 0
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

Sections [25] and [26] are static checks over source text as well as behaviour.
They constrain the shape of the wiring — for example that both generate paths
flush the instruction box before calling the worker, and that a single function
moves both per-chat boxes — because those are the mistakes that a functional test
would only catch by accident.

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
it exits, so running it does not consume your own first-run.

---

## 4. Release verification

```bash
node tools/build-release.js
node tools/verify-release.js dist/whatsapp-sales-ai-copilot-0.1.0.zip
```

16 assertions. Builds the ZIP, unzips it to a temporary directory, and installs
it into a throwaway Chrome for Testing profile with a temporary user-data-dir —
never the profile anyone sells from. It then asks Chrome's own extension API
whether the result is installed, enabled, at the version the manifest claims,
and free of manifest errors and warnings; reads the extension id off the running
service worker to prove the worker started; and finally opens the panel page and
confirms it boots to the welcome screen rather than to a half-rendered reply UI.

The ZIP's contents are asserted too: the manifest is at the root, and `tools/`,
`src/test/`, `.git/` and the documentation are all absent. That is the check
that stops the test bridge, the build scripts or a Git history from being
published as part of the extension.

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

## 6. Rules that must never be broken while testing

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
  names or chat excerpts in a report, a commit, an issue or a screenshot.
- Do not close, restart or clean up a browser that is in use without asking
  first, and never delete or rebuild WhatsApp's IndexedDB, Local Storage or
  cookies.
- The test bridge needs a **non-default** profile to be pointless and a
  **default** one to work: the bridge is designed precisely so no debugging port
  and no second profile is needed. Do not "fix" a bridge failure by reaching for
  CDP.

---

## 7. Known limits of the automated run

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
