# Security Policy — WhatsApp Sales AI Copilot

**Product:** WhatsApp Sales AI Copilot
**Brand:** Employee Zero
**Version:** 0.1.3
**Repository:** https://github.com/Employee-Zero/whatsapp-sales-ai-copilot

---

## Reporting a vulnerability

Please report security issues **privately**.

- **Use GitHub's private vulnerability reporting** on the repository:
  https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/security/advisories/new
  (Also reachable from the repository's **Security** tab → **Report a vulnerability**.)

- **Do not open a public issue for a security bug.** A public issue tells everyone about the problem before it can be fixed, and it puts anyone running the extension at risk. If you are unsure whether something is a security issue, report it privately anyway and let us sort that out.

This is a small open-source project maintained on a best-effort basis. There is no bug bounty and no guaranteed response time — but reports are welcome and will be taken seriously.

### What to include

- A description of the issue and the impact you believe it has.
- The version of the extension (0.2.0, or whichever version you tested). If the issue involves the helper, say which component and which release archive you took it from.
- Your Chrome version and operating system.
- Clear steps to reproduce, ideally the smallest set of steps that shows the problem.
- Any proof-of-concept code, screenshots or logs that help. If a screenshot would contain real conversation content or a key, redact it or describe it in words instead.
- Whether you are willing to be credited for the report, and under what name.

### What to expect

- An acknowledgement that the report has been received.
- An honest assessment of whether we agree it is a security issue and how severe we think it is.
- A note on what we intend to do about it, or a clear explanation of why we do not intend to change anything.
- Coordination with you before any public write-up, and credit in the release notes if you want it.

### Do NOT send us real data

> **Do not send real customer data, real conversation content, or API keys in a report.**

If a proof of concept needs data, use a fake conversation with fake names and fake messages. If a bug involves a credential, describe it — the header involved, the code path — and **rotate/revoke that key at your provider first**. Never paste a live key into an issue, an advisory, a comment or a screenshot. There is no reason for the project to ever see a working API key, and a report containing one will be treated as compromised.

---

## Security model and known limitations

This section is written to be honest about what the extension does and does not protect against. It is not a promise of security; it is a description of the design so you can judge your own risk.

### It deliberately automates a logged-in WhatsApp Web session

The extension's entire purpose is to work inside your already-logged-in WhatsApp Web session and act on the page in front of you.

- If someone else has access to your unlocked browser profile, they have access to your WhatsApp Web session. The extension does not add a login, a PIN, or a second factor, and it cannot protect a session that is already open.
- Anyone at your keyboard, on your unlocked machine, can use the extension to draft and send messages as you. Lock your screen.
- The extension does not and cannot enforce a "who is allowed to use this" boundary beyond the boundaries of your own browser profile.

### The API key is stored unencrypted

- Your AI provider's API key is stored in `chrome.storage.local` on your machine. It is **not encrypted by the extension**. This applies to the API-key method only; if you connect a ChatGPT plan, no key is stored in the browser at all.
- **Anyone with filesystem access to your browser profile can read it** — including anyone who can run code as your user, malware running as your user, anyone who copies or syncs your profile, and anyone who restores your profile from a backup.
- The extension limits where the key goes: it is only ever placed in the `Authorization: Bearer …` header of a request to the endpoint you configured. It is never logged and never rendered in the panel (only a masked presence hint). That limits accidental exposure; it does not protect the key at rest.
- Use a key scoped to only what you need, set spending limits at your provider, and revoke the key if you suspect exposure.

### The ChatGPT subscription credential is held by a local helper

There are two ways to connect an AI provider. The second one — signing in with a ChatGPT plan — involves **ChatGPT Connector**, a small background app made by Employee Zero (source in `helper/`), installed on macOS from a `.pkg` on the GitHub Release. The `.pkg` is not signed with an Apple Developer ID or notarized; install it only from this repository's releases. This section is about what that does and does not protect.

**Why it is a separate program, not part of the extension.** OpenAI's sign-in for open-source and locally hosted apps accepts only a callback to an HTTP listener on `127.0.0.1`; the path is fixed, only the port may vary, and `localhost` is explicitly not accepted. `chrome.identity.launchWebAuthFlow` only intercepts `https://<extension-id>.chromiumapp.org/*`, which is not an accepted redirect, and an MV3 extension cannot open a listening socket. So the callback has to be received by an ordinary local process. The extension declares no `identity` permission and never calls `launchWebAuthFlow`.

**The same restriction is the security win.** The alternative designs would put the credential where an XSS, a compromised dependency, or a content script could reach it. Instead:

- The credential lives in one file — `~/.config/whatsapp-sales-ai-copilot/credentials.json` on macOS and Linux, `%APPDATA%\whatsapp-sales-ai-copilot\credentials.json` on Windows — created `0700` for the directory and `0600` for the file, written atomically via a temporary file and a rename. On Windows those POSIX modes do not apply and the file inherits your user profile's permissions; `--status` reports which of the two happened.
- **The extension never receives a token and has no field that could store one.** Credentials are not in `chrome.storage.local`, not in the page, not passed to the WhatsApp content script, and not logged. The helper's log lines name the account's email label and nothing else.
- The helper binds `127.0.0.1` only — never the wildcard address, so it is not on your local network — and checks every request: the `Host` header must be the loopback address itself (which is what stops a DNS-rebinding attack from a page in your browser reaching it), the `Origin` must be absent or a `chrome-extension://` origin, and the body must be JSON, which forces a cross-origin request into a CORS preflight that the helper then refuses. It never emits an `Access-Control-Allow-Origin` header.
- **What this does not protect against.** Anyone who can run code as your user can read the credential file, exactly as they could read an API key out of your browser profile, and they can also just call the helper's endpoints. The helper is not a privilege boundary against local malware. It is a boundary against the credential being reachable from web content, which is a different and more commonly exploited thing.
- **Sign-out revokes.** Signing out from the extension calls the revocation endpoint published in OpenAI's OIDC discovery document, then deletes the file. Deleting the file by hand stops the extension using it but does not revoke it at OpenAI, so sign out rather than only deleting if you want it revoked.

### Where your conversation data goes

- To generate a reply, conversation text is sent to the AI provider **you configured**. It leaves your machine. The provider's handling of it is governed by that provider's policy, not by this project — see `PRIVACY.md`. With the subscription method the provider is OpenAI, and the request goes to the public Responses API, not to any ChatGPT-internal endpoint.
- The optional host permissions are requested at the moment they are needed and are never granted up front. The extension asks for `http://127.0.0.1/*` when you click **Allow Access** (or **Recheck**), because the Connector listens there; that is the only permission the shipped extension ever requests by itself. The wider ones (`https://*/*`, `http://localhost/*`) exist so an endpoint **you** type into Settings can be reached, and nothing in the shipped extension asks for them — they are there for the case where your provider is not already covered.
- **An optional permission is not a harmless one.** Once granted, it persists for that Chrome profile until you revoke it on `chrome://extensions`. The loopback grant lets the extension talk to anything else listening on `127.0.0.1` that does not defend itself, so grant it only if you intend to use the subscription method, and revoke it if you stop.
- The development test bridge (`src/test/bridge.html`) is the other thing in the repository that calls `chrome.permissions.request`. It is excluded from the release ZIP and is not part of the shipped extension.

### The send guard, and what it does not do

Before the extension sends anything it runs a guard:

- It checks that **a conversation is open**.
- It checks that the conversation **has not changed during generation** — so a reply drafted for one chat is not fired off into a different one that happened to open mid-generation.

What it does **not** do:

- **There is no recipient allowlist.** There is no list of approved contacts, no per-chat permission, no "are you sure this is the right customer" check beyond the guard above.
- **A user who clicks Send sends to whatever chat is open.** If the wrong chat is open when you click, the message goes to the wrong chat. Read the recipient before you send.
- **Follow-up & Send sends without showing the message first and has no confirmation step.** It writes into the chat that is open, so check which chat is open before using it. The button carries a two-line warning; that warning is the only safeguard.

### The development test bridge is not part of the shipped extension

The repository contains a development-only test bridge (`src/test/bridge.html`) used to exercise the extension outside of a real WhatsApp session. It is bound to loopback (`127.0.0.1`) and exists only for local development and testing.

- **It is excluded from release builds and is not part of the shipped extension.** A build taken from a release (a packaged `.crx`/store build, or a build produced by the release tooling) does not contain it.
- If you load the extension from the raw repository source as an unpacked extension for development, you have the development tree, not a release build, and the bridge is present. Treat anything you run that way as a development environment.
- Do not ship, publish, or distribute a build that still contains the test bridge, and do not expose its port beyond loopback.

### Scope of this project

There is no backend server, no account system, no author-operated subscription and no author-operated service, so there is no server-side surface to attack — that is true of the ChatGPT method as well, because the helper runs on your machine and talks to OpenAI directly. The relevant surface is the extension itself, the page it operates on, the helper process if you run it, and the endpoint you configure.

### Reporting a problem with the helper specifically

If the issue is in `helper/`, say so in the report — it is a separate component with its own release archive, and the fix will ship in that archive rather than in the extension. Reports about the loopback listener's request checks are especially welcome. Do not paste a real credential file into a report; if you need to show its shape, replace every value with a placeholder.
