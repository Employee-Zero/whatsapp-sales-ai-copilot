# Security Policy — WhatsApp Sales AI Copilot

**Product:** WhatsApp Sales AI Copilot
**Brand:** Employee Zero
**Version:** 0.1.0 (first public release)
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
- The version of the extension (0.1.0, or whichever version you tested).
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

- Your AI provider's API key is stored in `chrome.storage.local` on your machine. It is **not encrypted by the extension**.
- **Anyone with filesystem access to your browser profile can read it** — including anyone who can run code as your user, malware running as your user, anyone who copies or syncs your profile, and anyone who restores your profile from a backup.
- The extension limits where the key goes: it is only ever placed in the `Authorization: Bearer …` header of a request to the endpoint you configured. It is never logged and never rendered in the panel (only a masked presence hint). That limits accidental exposure; it does not protect the key at rest.
- Use a key scoped to only what you need, set spending limits at your provider, and revoke the key if you suspect exposure.

### Where your conversation data goes

- To generate a reply, conversation text is sent to the AI provider **you configured**. It leaves your machine. The provider's handling of it is governed by that provider's policy, not by this project — see `PRIVACY.md`.
- The optional host permissions (`https://*/*`, `http://localhost/*`) exist so that the endpoint **you** enter can be reached — a provider of your choice over HTTPS, or a model server on your own machine. They are optional, they are granted per-origin, and **nothing in the shipped extension asks for them**: the only code in the repository that calls `chrome.permissions.request` is the development test bridge, which is not in the release ZIP. Grant them for the origin you actually use, not broadly, if you want the smallest footprint. An optional permission is not a harmless one: once granted, it persists for that Chrome profile until you revoke it on `chrome://extensions`.

### The send guard, and what it does not do

Before the extension sends anything it runs a guard:

- It checks that **a conversation is open**.
- It checks that the conversation **has not changed during generation** — so a reply drafted for one chat is not fired off into a different one that happened to open mid-generation.

What it does **not** do:

- **There is no recipient allowlist.** There is no list of approved contacts, no per-chat permission, no "are you sure this is the right customer" check beyond the guard above.
- **A user who clicks Send sends to whatever chat is open.** If the wrong chat is open when you click, the message goes to the wrong chat. Read the recipient before you send.
- The follow-up action asks for confirmation before sending a message you have not previewed, but confirmation is a prompt, not a correctness check. It cannot know who you meant to message.

### The development test bridge is not part of the shipped extension

The repository contains a development-only test bridge (`src/test/bridge.html`) used to exercise the extension outside of a real WhatsApp session. It is bound to loopback (`127.0.0.1`) and exists only for local development and testing.

- **It is excluded from release builds and is not part of the shipped extension.** A build taken from a release (a packaged `.crx`/store build, or a build produced by the release tooling) does not contain it.
- If you load the extension from the raw repository source as an unpacked extension for development, you have the development tree, not a release build, and the bridge is present. Treat anything you run that way as a development environment.
- Do not ship, publish, or distribute a build that still contains the test bridge, and do not expose its port beyond loopback.

### Scope of this project

There is no backend server, no account system, no subscription and no author-operated service, so there is no server-side surface to attack. The relevant surface is the extension itself, the page it operates on, and the endpoint you configure.
