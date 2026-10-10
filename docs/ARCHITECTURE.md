# Architecture

How WhatsApp Sales AI Copilot is put together: which module owns what, how a
reply travels from the page to the customer, and why the safety checks sit where
they do.

## 1. Scope

One thing, done well:

```
the open WhatsApp Web conversation
      → read the messages already loaded
      → ask the AI for a reply
      → show it as an editable draft
      → send it
```

**There is no backend.** The whole system is a Chrome extension plus an
OpenAI-compatible AI API that the user configures:

```
Chrome extension  ──►  the user's own /chat/completions endpoint
```

Deliberately not built (Phase 2/3): scrolling to load history, scanning the chat
list on the left, bulk follow-up, n8n, Supabase, Pipedrive, Dify, a knowledge
base, speech recognition, image understanding, attachment analysis, automatic
CRM updates.

## 2. Module layout

```
whatsapp-sales-ai-copilot/
├── manifest.json                  MV3 manifest
├── src/
│   ├── background/
│   │   └── service-worker.js      orchestration + the authoritative send gate + the busy lock
│   ├── content/
│   │   ├── whatsapp-adapter.js    ★ every WhatsApp DOM read and write (the only place)
│   │   └── content-script.js      message routing + chat-identity guard + message accumulator
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.css
│   │   └── sidepanel.js           panel controller (light theme, see sidepanel.css)
│   ├── ai/
│   │   └── ai-client.js           AI requests (visible only to the service worker)
│   ├── shared/
│   │   ├── constants.js           default config, message types, error codes, limits
│   │   ├── constants.classic.js   ↑ classic-script copy (generated — do not edit)
│   │   ├── utils.js               phone normalisation, endpoint resolution, window merging, error classification
│   │   └── utils.classic.js       ↑ classic-script copy (generated — do not edit)
│   └── test/                      development-only test bridge and screenshot harness (never shipped)
├── tools/                         Node.js development tooling (never shipped)
└── docs/
```

| Module | Responsibility | How often it changes |
|---|---|---|
| `whatsapp-adapter.js` | All DOM queries and DOM actions | **High** — when WhatsApp redesigns, this is the only file that changes |
| `content-script.js` | Message routing, chat-identity guard, message accumulator | Medium |
| `service-worker.js` | Orchestration, send gate, busy lock | Low |
| `ai-client.js` | AI requests, fallback, error classification, config | Low |
| `sidepanel.js` | UI state, draft isolation, per-chat instructions, button enablement | Medium |

**Key constraint:** `WhatsAppAdapter` must contain no AI logic, no network calls
and no orchestration. Future features such as a conversation scanner must not be
folded into it either.

### 2.1 Persisted state

| storage key | contents | who writes it |
|---|---|---|
| `aiConfig` | AI configuration (see §10) | service worker / side panel |
| `aiConfigSeeded` | whether the first install has been seeded with defaults | service worker |
| `messageStore` | accumulated per-conversation message window, `{ [chatId]: {id, name, updatedAt, messages} }` | content script |
| `drafts` | per-conversation unsent draft, `{ [chatId]: {text, state, at} }` | side panel |
| `instructions` | per-conversation extra instruction, `{ [chatId]: {text, at} }` | side panel |
| `onboarding` | first-run flags, `{ connected, dismissed }` | side panel |

### 2.2 Why the `*.classic.js` copies exist

The same shared file **cannot** be an ES module and a classic content script at
once:

- `service-worker.js` is loaded with `"type": "module"`, where `import` is the
  only legal way to reuse code;
- the content script and `sidepanel.html` are classic scripts, where a single
  `export` aborts the whole file with
  `Uncaught SyntaxError: Unexpected token 'export'` — and the file does not
  partially run. Every constant in it becomes `undefined`, and the content
  script fails silently.

So `constants.js` and `utils.js` stay ESM, and each ships a second time as a
`*.classic.js` copy with the `import` lines and the trailing `export { … }`
block removed. The declarations are otherwise identical, which is why the copy
is generated rather than maintained by hand:

```
node tools/build-classic.js           # write the copies
node tools/build-classic.js --check   # fail if a copy is stale
```

**Editing a shared module without regenerating its copy fails silently.** The
new constant simply does not exist on the page side. This has already happened
here once: the panel's Send button sent a message type that had never been
defined on the classic side. `node tools/test-safety.js` tests the *generated
copies*, so a stale copy is what gets tested — `--check` is what catches it.

## 3. Data flow

### 3.1 Generate Reply (read-only, works for any conversation)

```
Side panel
  │ chrome.runtime.sendMessage({type: GENERATE_REPLY})
  ▼
Service worker
  │ acquireLock('generate')
  │ assertConfigured()  ← a brand-new install is told to configure, not to open a chat
  │ chrome.tabs.query → find the WhatsApp tab
  ▼
Content script ── GET_CHAT_CONTEXT
  │ adapter.getChatId()              ← conversation identity (dm:<anchor> / group:<anchor>)
  │ adapter.getCurrentContactName()
  │ adapter.getLoadedMessages()      ← reads the rendered DOM only, never scrolls
  │ accumulate(chatId, …)            ← merges with the stored window (only ever grows)
  │ adapter.getCurrentPhone()        ← passive read; does not open the contact drawer
  ▼
Service worker
  │ loadAiConfig()  ← chrome.storage.local
  │ limitMessages(messages, cfg.contextMessages)   ← trims by count, then by characters
  │ generateReply() → ai-client → POST /chat/completions
  ▼
Side panel (shows the draft for editing; stores it under chatId in drafts)
```

### 3.2 Follow-up & Send

```
Side panel
  │ layer 1 of the UI: Send is disabled while no conversation is open
  │ asks "send without showing you the message first?" and names the recipient
  ▼
Service worker ── acquireLock('followup')
  │ 1. read the chat + generate the reply
  │ 2. re-read the live context and compare chatId   ← catches a chat switch during generation
  │ 3. assertSendAllowed(live)                       ← worker-side gate: a conversation must be open
  ▼
Content script
  │ 4. setComposerText(text)   writes into the composer and verifies the write landed
  │ 5. assertSafeToSend(chatId)
  │      · hasOpenChat()
  │      · adapter.getChatId() read again and compared   ← layer 2 gate
  │ 6. clickSend()
  │    on failure → clearComposer()   ← never leave a draft in the wrong box
  ▼
WhatsApp Web
```

The reply is never sent by the extension's own HTTP call. The extension writes
into WhatsApp's composer and clicks WhatsApp's own Send button, so the message
leaves through the same path a typed message would.

## 4. Sending safely: two independent layers

The recipient allowlist this project used to carry has been removed now that it
is a general product. Two independent checks remain, and either can stop a send
on its own.

### 4.1 Layer 1 — the service worker (`assertSendAllowed`)

Before sending, it confirms that a conversation is genuinely open (the context
has a non-empty `chatId`). With no conversation open, clicking Send fires into
whatever input happens to hold focus — this layer exists for precisely that.

### 4.2 Layer 2 — the content script (`assertSafeToSend`)

The last check before the click, and the most important one: it reads
`adapter.getChatId()` from the **live DOM** again and compares it with the
identity the draft was generated for. A mismatch raises
`CHAT_CHANGED_DURING_GENERATION`.

**A refused send clears the composer** (`guardedSend`). The draft was written
into the composer *before* the guard ran — that is the whole reason the guard
sits here and not earlier. Once it refuses, the composer is holding text meant
for a different customer; leaving it there means one press of Enter sends it to
the wrong person. This is also why the two layers are separately reachable: the
worker's diagnostic path can ask the content script to click Send directly,
bypassing the worker's own gate, which is how layer 2 is shown to stand on its
own.

### 4.3 The chat-identity guard

The requirement is blunt: **analysing one conversation and then switching to
another must never send the first customer's reply to the second.**

The guard's key is `adapter.getChatId()` — the conversation *identity*, not a
content fingerprint:

```js
{ id: 'dm:<anchor>' | 'group:<anchor>', stable: boolean }
```

The anchor is the first of these that can be read:

1. a phone number in the header title (WhatsApp shows the number as the title
   when the contact is not saved);
2. the recipient named in the composer's `aria-label`, which is refreshed on
   every chat switch;
3. the title text itself.

The chat id is captured when generation starts, then recomputed and compared in
two places: the service worker, immediately after the AI returns, and the
content script, immediately before the Send click. Either mismatch raises
`CHAT_CHANGED_DURING_GENERATION`, cancels the send, clears the composer, and
shows the user:

```
Chat changed while generating. Send cancelled.
```

along with a line telling them to generate again for the conversation now on
screen.

**Why not `chatKey`** (which is what earlier revisions used): `chatKey` embeds
the row count and the first and last 40 characters of the transcript, so *sending
a message changes it*. It can only answer "has the conversation moved on?", and
it reports "I just sent a message" as "the chat changed". `chatId` contains
nothing volatile, survives a send, and means what the guard needs it to mean.

`chatKey` is still returned with `GENERATE_REPLY` as diagnostics, and the phone
cache is still keyed by it — the cached value is "the number read for this
content", so following the content is correct, and it cannot outlive a chat
switch.

### 4.4 Phone numbers are display-only

The number is shown to the user; it is not a send gate.

- Reading is **passive** by default: if the contact drawer is already open, read
  it; if the title itself is a number, use that.
- `phoneFromDisplayName()` accepts a title as a number only when it *is* one, so
  saved contact names, group subjects and digit-bearing words never become a
  number.
- The contact drawer is opened only when the user explicitly asks (the
  **Re-read** action), because otherwise every chat switch would make the panel
  flash.
- A group has no single number, and says so.

## 5. The message accumulator (grows, never shrinks)

WhatsApp's message list is virtualised: the DOM holds a window of rows, and
scrolling loads older rows while evicting newer ones. Sampling one conversation
repeatedly, the DOM row count bounces around while the accumulator's count only
rises.

`accumulate(chatId, name, fresh)` in `content-script.js`:

```
fresh (the DOM's current window)
        │
        ▼
alignMessageWindows(stored, fresh)     ← tries every offset d so that fresh[j] ↔ stored[j+d];
        │                                keeps the best match with a match rate ≥ 0.6
        ▼
mergeMessageWindows(stored, fresh)     ← union in aligned coordinates, overlaps taken from fresh
        │                                (messages get edited, delivery states get filled in)
        ▼
chrome.storage.local.messageStore[chatId]
```

- Two windows that do not overlap at all (the user scrolled a long way up) get a
  gap marker inserted between them: `[... N messages in this conversation are
  not loaded ...]`. Scrolling up puts the newer window in front, hence
  `prepend: true`.
- **The 4-second poll does not write to storage**: if the merged head and tail
  match what is already stored, it returns without touching storage.
- Capacity is bounded by `MESSAGE_STORE_LIMITS`: 600 messages / 400,000
  characters per conversation, 40 conversations globally (the least recently
  updated are evicted). Going over the cap trims silently from the front and
  inserts no gap marker.

The accumulator only solves "do not lose what has already been read". It does
**not** weaken the read-only rule: the extension still does not scroll on its
own, does not ask for history, and does not touch the chat list.

## 6. The context cache

A single "Follow-up & Send" click reads the conversation five times (read →
generate → re-read → send → re-check). `getLoadedMessagesCached()` keys a cached
transcript on `_contextSignature()`, turning the repeated reads into a lookup.

The signature must include **the text of the first and last rendered rows**, not
just a row count: WhatsApp keeps only a window of rows in the DOM, so sending a
message appends a row at the bottom *and evicts one at the top*. The count is
unchanged, and a count-only signature would cheerfully serve a transcript that
is missing the message that was just sent.

```
[header text, row count, first row text (60 chars), last row text (60 chars), composer length]
```

## 7. Preventing duplicate sends

A process-wide busy lock in `service-worker.js`:

```js
let inFlight = null;
function acquireLock(name) {
  if (inFlight) throw Object.assign(new Error(…), { code: ERR.BUSY });
  inFlight = { name, startedAt: Date.now() };
}
```

It covers all five operation classes — `read`, `generate`, `send`, `followup`,
`test` — and is released in `finally`. Together with the panel's `busy` flag and
its button spinners, a double click, a slow network round trip or a panel
re-render cannot produce a second send.

Below that, `sendCurrentMessage()` has its own check: after clicking, the
composer must be empty. If the text is still there, the click did not submit, and
it reports `SEND_DID_NOT_SUBMIT` rather than claim success — the caller must
never click Send twice on the same text.

## 8. Per-chat state

### 8.1 Drafts

```js
chrome.storage.local.drafts[chatId] = { text, state, at }   // state: '' | 'draft' | 'sent'
```

Drafts are stored per conversation, and one function (`syncPanesToChat()`)
switches both per-chat boxes at once. Without this layer, a draft generated for
one customer stays in the box after switching to the next one, and its Send
button sends the first customer's reply to the second.

**A draft in the `sent` state is never persisted.** After a successful Follow-up
& Send, the delivered text is left on screen so the user can see what went out;
storing it would restore it in a later session next to an enabled Send button —
one click away from sending it twice. `saveDraft()` stores an empty string for
`sent`, which is the same as deleting the entry.

When no `chatId` can be read (`stable === false`), no draft is stored and no
isolation is attempted. That is a deliberate fail-open: the alternative would be
refusing to work in the moment the header has not rendered yet. Drafts fade out
after 40 chats and are capped at 6,000 characters each.

### 8.2 Per-chat instructions

The mirror image of a draft, with the same lifecycle and the opposite
direction: a draft is the AI's output, shown only to the user; an instruction is
the user's input, shown only to the AI. Keyed by `chatId` the same way:

```js
chrome.storage.local.instructions[chatId] = { text, at }   // no state field
```

No `state`, because an instruction is never sent anywhere — there is no `sent`
state to have.

**Why per conversation:** a general system prompt answers "how do we talk, as a
company". "Ask how the trial installation went" is true for one customer and
noise for the next.

**It is appended to the system message, not added as a user turn** (`ai-client.js`):

```js
{ role: 'system', content: systemPromptFor(cfg) + instructionBlock(ctx.instruction) }
```

Two reasons. Precedence: the general prompt already lives in the system message,
and the only way for a specific instruction to outrank general guidance is to
come after it, inside the same higher-priority message — put it in the user
message and the model reads it as something the customer said. And wording:
`instructionBlock()` states that this comes from the salesperson and takes
priority where the two conflict.

That precedence is **bounded**, on purpose: the closing lines of
`instructionBlock()` declare that it does not override the rules against
inventing prices, specifications, certifications, delivery promises, stock,
discounts or payment terms. A nudge like "ask how the trial went" is a useful
addition; if it could override the no-invention rules, the instruction box would
be a back door around the guard rails — and the message goes to a real customer.
The offline tests assert those two sentences are present.

**The panel UI is a three-state fold:**

| State | What is on screen |
|---|---|
| empty | a one-line, 30px `Add an instruction for this chat · optional` row |
| editing | an amber input with Done / Clear |
| written and collapsed | a two-line truncated amber chip with Edit |

The colour is part of the safety design: **green is what the AI produced, amber
is what the user is telling the AI**. The reply box and the instruction box look
nothing alike, because only one of them can be sent to a customer.

After a generation the box collapses to a chip rather than hiding, so the user
can check "did it answer what I asked?" against what they typed.

Two easy mistakes this code guards against:

- the instruction box has a 400 ms debounce, and clicking Generate easily lands
  inside it. Both `GENERATE_REPLY` and `FOLLOWUP_AND_SEND` therefore
  `await flushInstruction()` before calling the worker; otherwise the worker
  reads the previous instruction, or none.
- switching chats moves both boxes through the single function
  `syncPanesToChat()`. Splitting it in two would require two "previous chat id"
  variables, and two variables that must always be equal eventually are not.

Instructions are capped at 40 chats and 1,000 characters each.

## 9. WhatsApp DOM strategy

WhatsApp changes its DOM constantly. `whatsapp-adapter.js` tries selectors in
this order:

1. **semantic attributes** — `data-testid="conversation-panel-messages"`,
   `data-icon="send"`;
2. **role** — `div[role="row"]`, `div[role="textbox"]`;
3. **aria-label**;
4. **contenteditable** — the composer's Lexical editor;
5. **stable `data-*`** — `data-tab`;
6. **DOM structure** — `header`, `footer`, `#main`;
7. **generated class names** — last resort, and only with a structural fallback.

Message direction is decided by, in order:

1. the tail markers (`tail-out` / `tail-in`), which are authoritative but appear
   only on the last row of a run;
2. an outgoing-only label on the first row of a run;
3. the delivery-status labels on our own rows (read / delivered and friends);
4. a geometry fallback: measure the *bubble*, not the row;
5. inherit the previous row's direction.

The geometry comparison itself lives in `utils.js` as `directionFromGaps()` — a
pure function, so it can be unit-tested without a browser. **Our bubbles hug the
right edge, so the left gap is the larger one.** That inequality has been
written backwards once already, which classified half the rows as incoming.

Direction is decided **before** inheritance, never after: the second line of a
bubble is a continuation with no tail marker of its own, and geometrically it
sits to the left, so a geometry-first pass would confidently call it incoming.

The sender-name attribute WhatsApp attaches to each message does **not**
participate in direction detection. It holds the sender's display name, not a
number, while the cached number belongs to the contact of the currently open
chat — comparing the two can only be wrong.

**Reading messages is strictly read-only.** `getLoadedMessages()` iterates the
rendered message containers only. It does not scroll, does not request history,
and does not touch the chat list. It also never uses the generic row role: in
the current build the chat-list entries on the left carry the same role, and
using it would leak the chat list into the transcript.

## 10. AI configuration

### 10.1 Layering

```
chrome.storage.local.aiConfig
        │ missing
        ▼
DEFAULT_AI_CONFIG           (source defaults — every connection field is empty)
        │
        ▼
migrateStoredConfig(raw)    ← runs before mergeConfig; see 10.4
        ▼
mergeConfig(DEFAULT_AI_CONFIG, migrated) → normalised → the request
```

Storage is re-read on every request, so a change in Settings takes effect
immediately and **never** requires editing source.

`loadAiConfig()` deliberately does not fall back to a shipped Base URL. When the
project was published, its defaults became empty strings — no default provider,
no default model, no default key — because shipping one would mean publishing
somebody's endpoint and having every install spend somebody's credits. An empty
string is the honest answer, and the panel turns it into the setup screen.

`publicConfig()` is what the panel is allowed to see: it carries `hasApiKey`
and a masked `keyHint` (the last four characters), never the key. It also
carries `hasRequiredConfig`, `missingFields` and `missingFieldLabels` so the
panel and the worker answer "is this configured?" with the same rule instead of
drifting apart.

### 10.2 Schema

| Field | Values | Default | Effect |
|---|---|---|---|
| `primaryBaseUrl` / `fallbackBaseUrl` | URL | empty | endpoints |
| `apiKey` / `model` / `temperature` | — | empty | ordinary request fields |
| `maxTokens` | `0` = derive automatically, `>0` = explicit | `0` | output token ceiling |
| `replyLength` | `short` / `medium` / `long` | `medium` | length guidance + base output budget |
| `thinking` | `off` / `auto` / `low` / `high` | `auto` | maps to the request body's `thinking` field |
| `contextMessages` | `0` / `20` / `50` / `100` | `0` (all) | how many recent messages go to the model |
| `maxChars` | 1000–100000 | `20000` | hard character cap on the context |
| `systemPrompt` | string | the shipped default prompt | editable, with a Reset |
| `timeoutMs` | 5000–120000 | `30000` | per-request timeout |

`AI_CONFIG_NUMBER_RANGES` and `AI_CONFIG_STRING_KEYS` are the only source of
validation; `saveAiConfig()` checks every field and refuses anything out of
range. An empty API key field means "keep the stored key" — only the explicit
Clear-key action clears it.

### 10.3 Deriving the output budget (`resolveMaxTokens`)

```
maxTokens > 0 ? clamp(maxTokens, 16, 8192)
              : clamp(REPLY_LENGTH_SPECS[replyLength].outputTokens
                      + THINKING_SPECS[thinking].reserveTokens, 16, 8192)
```

The default (Medium + Auto) resolves to 3048. `publicConfig()` exposes it as
`effectiveMaxTokens`, and Settings shows it.

### 10.4 Migrations

`migrateStoredConfig(raw)` brings a stored config forward to the current schema.
It must run on the **raw** object, before `mergeConfig` — merging first stamps
the current `configVersion` onto an old config, after which the version check is
always satisfied and the migration never fires.

- **v1 → v2:** a stored `maxTokens: 300` (an old default that was smaller than a
  reasoning model's thinking budget on its own) is handed back to automatic
  (`0`).
- **v2 → v3:** the pre-publish prompt, which was written around one company's
  products, is replaced by the current default — but only when the stored string
  is byte-for-byte the old default. A prompt the user actually edited is left
  alone. The connection fields (Base URL, key, model) are **never** touched by
  this migration, so a working install keeps pointing where it pointed.

### 10.5 Thinking and empty replies

`thinkingRequestParam(mode)` returns `null` for `auto`, and the field then does
not appear in the request body at all — a non-reasoning model may reject an
unknown field with HTTP 400. `off` sends a disabled marker; `low` and `high`
send an enabled one with a budget.

A configured `budget_tokens` is accepted by providers but does not tightly bound
how much the model actually reasons, so the three levels are a tendency, not a
guarantee.

On a reasoning model the thinking tokens are billed against `max_tokens`. A
budget that is too small is therefore spent entirely on thinking and the content
comes back empty — HTTP 200, no error, no text. That was the real cause of the
old "The AI returned an empty reply" failure.

`callChatEndpoint()` does **not** throw on an empty reply. It returns
`{ text: '', finishReason, usage, maxTokens }`, treating "empty" as a decidable
result, and `generateReply()` decides:

```
empty text, or finish_reason === 'length'
   → retry once with min(8192, max(base × 3, base + 1024))
       still empty      → throw AI_RETURNED_EMPTY (with reasoningTokens / maxTokens)
       still truncated  → throw AI_TRUNCATED (with the partial text)
```

Throwing inside the endpoint call was what made the retry unreachable: it fired
before the caller could ever look at `finish_reason`.

### 10.6 Fallback

Only **connectivity** failures switch to the fallback endpoint:

| Failure | Switch? |
|---|---|
| network error / DNS failure / connection refused / TLS error / connection timeout | ✅ yes |
| HTTP 401 / 403 (key) | ❌ no |
| HTTP 404 (endpoint) | ❌ no |
| model not found / bad request | ❌ no |
| 429 rate limit | ❌ no |

The reason: 401 and 404 are configuration problems. Trying another host hides
the real error and doubles the latency. `classifyNetworkError()` decides
connectivity from `fetch`'s `TypeError` and `AbortError`.

## 11. First run

`chrome.runtime.onInstalled` calls `seedAiConfigIfMissing()`, which writes the
default config record when storage has no `aiConfig`. The seeded values are
deliberately **empty** — no provider, no model, no key — so the panel shows a
setup screen instead of a Generate button that cannot work. An install that
already has a config is left exactly as it is, which is what lets an existing
user's provider and key survive an update.

The panel then picks one of three states on every render:

| Condition | On screen |
|---|---|
| the connection fields are incomplete | the **setup card**, unconditionally: Base URL, API Key and Model, with a Test button that checks the values before saving them |
| complete, but the user has not seen the next step | a short **three-step list** ("what to click next") |
| complete, and dismissed | neither. Settings stay reachable behind the gear icon, and only open when asked |

Two details matter. "Connected" is recorded only when the saved result genuinely
has everything a request needs — a half-filled form must not dismiss the screen
that is still asking for the rest. And the API key is never rendered back into
the field: it is left blank with a masked hint, so replacing a key never means
deleting the old one out of the DOM first.

The first-run flags live in their own `onboarding` record rather than inside the
AI config: they describe what the *user* has seen, not how the extension talks
to a provider, and clearing one must never be a side effect of the other.

## 12. Message protocol

Side panel ↔ service worker ↔ content script all speak
`chrome.runtime.sendMessage`, and every reply is `{ok: true, …}` or
`{ok: false, code, message}`. Error codes are centralised in `ERR` in
`constants.js`; a bare string exception is never returned. `publicContext()`
narrows the context payload to the fields the panel needs, so internals of the
adapter do not leak across the boundary.

## 13. Permissions

```json
"permissions": ["sidePanel", "storage", "scripting", "activeTab"],
"host_permissions": ["https://web.whatsapp.com/*"],
"optional_host_permissions": ["https://*/*", "http://localhost/*"]
```

Deliberately **not** requested: broad `tabs`, `webRequest`, `<all_urls>`,
`cookies`, `history`, `downloads`.

| Declaration | Why it is there | Who asks for it |
|---|---|---|
| `host_permissions: https://web.whatsapp.com/*` | The content script and the adapter only ever run on WhatsApp Web | Granted at install |
| `optional_host_permissions: https://*/*` | The Base URL is the user's choice; any HTTPS OpenAI-compatible provider has to be reachable | Nothing in the shipped code — see below |
| `optional_host_permissions: http://localhost/*` | A model server on the user's own machine (Ollama, vLLM, LM Studio) is a documented setup | `src/test/bridge.js`, the dev bridge |

Two honest notes about the optional pair, because "optional" is not the same as
"harmless":

- **No shipped code requests them.** The extension does not call
  `chrome.permissions.request` anywhere outside `src/test/`. An AI request is an
  ordinary cross-origin `fetch`, which succeeds when the provider answers with
  permissive CORS and would need a granted host permission when it does not. So
  the optional patterns are a declared *capability*, not a claim that the request
  path depends on them. A future Settings affordance that asks for the user's
  provider origin is the natural place to use `https://*/*`.
- **An optional host permission is still a permission.** Chrome does not show it
  at install, and it does nothing until something asks for it and the user
  approves — but once granted it persists for the profile. It is scoped as
  tightly as the feature allows: `https://*/*` (HTTPS only, because a plaintext
  `http://` provider would put the API key on the wire in clear) plus loopback.

`src/test/bridge.js` uses the same `http://localhost/*` pattern rather than a
second `http://127.0.0.1/*` entry. One loopback declaration covers both the user
who runs a local model server and the dev bridge, so the published manifest
carries no permission whose only justification is testing. (It previously
carried both, and the docs claimed otherwise; that is what this section now
records correctly.)

## 14. Known limits and technical debt

| Item | Note |
|---|---|
| Phone reading depends on the contact drawer | A WhatsApp redesign can change the drawer's structure; the reader has three fallback levels |
| `getChatId()` can collide | Two unsaved contacts who both set the same display name produce the same `dm:<name>`, so their drafts and accumulated history mix |
| `getChatId()` can be unavailable | If no anchor can be read it returns `{id:'', stable:false}`; drafts are then not isolated and layer 2 lets the send through (a deliberate fail-open) |
| Accumulator caps | 600 messages / 400,000 characters per chat, 40 chats globally; over the cap, trimming is silent and inserts no gap marker |
| Phone display is not grouped | `formatPhoneDisplay` prints the full international form without separators, so it does not visually match WhatsApp's own grouping in the header |
| `chatKey` | Still returned as diagnostics, but no longer part of any send decision |
| Chrome refuses a debugging port on the default data directory | `--remote-debugging-port` is refused even when the default profile path is passed explicitly, so CDP is effectively closed on the Chrome a user actually browses with. `AGENTS.md` §2 covers this, and the test bridge in §4 of the same file is the answer |
| Not enough room to run DOM automation anyway | Solved: `src/test/` carries a loopback test bridge. Node scripts command an already-open extension page over the loopback interface (`127.0.0.1` on the Node side, `localhost` in the page) — no debug port, no second profile, no QR code |
| Instructions are not verified end to end on the worker side | The panel write and the outgoing request body are verified on a real machine; the worker's own `loadInstruction()` → `generateReply` leg is covered only by offline contract tests, because it needs a signed-in WhatsApp session |
| No retry for AI requests | A failure switches primary → fallback once. The only retry is the larger budget after an empty or truncated reply |
| The extension never confirms delivery | It knows the message left the composer, not that the server accepted it |

## 15. Phase 2 extension points

Structurally provided for, deliberately not built:

1. **Conversation scanner** — a separate `src/scan/`, working through the
   adapter's read-only API, without reaching into `WhatsAppAdapter` itself;
2. **Multi-step follow-up strategy** — a prompt-template selector in
   `ai-client.js`;
3. **Local history cache** — `chrome.storage.local` or IndexedDB, decoupled from
   DOM reads;
4. **Bulk operations** — a new orchestration layer, where every message must
   reuse `assertSendAllowed` per conversation.
