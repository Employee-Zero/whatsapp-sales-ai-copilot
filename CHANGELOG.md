# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.2] - 2026-10-12

### Added

- **ChatGPT Connector for Sales AI Copilot**: the macOS (Apple Silicon) installer for the ChatGPT method, as a `.pkg` with a one-click **Download for Mac** in the extension. Shown in Login Items by name through a minimal background app bundle. Not Developer ID signed or notarized.
- Three-step ChatGPT setup in the panel (Install, Allow Local Access, Connect) with live status badges and a **Recheck** button.
- Brand icons, single-page Settings, tip field, received/sent counts, **Reload**.

### Fixed

- The installer failed with `postinstall` not found (not executable).
- First ChatGPT sign-in now uses the issued client ID for the token exchange; models and Responses request shapes corrected; limited retry for connections reset before TLS.
- "Generating…" disappeared after 4.5 s on slow replies, before the reply was written.

## [0.2.0] - 2026-10-11

Connect an AI provider two ways: sign in with a ChatGPT plan, or use your own API key. Both are offered in the first-run setup and in Settings, and switching between them keeps the other one's settings, your per-chat instructions and your drafts.

### Added

- **Sign in with ChatGPT.** Use the ChatGPT plan you already pay for. You sign in to OpenAI in a normal browser tab, the extension lists the models your account can use, and replies are written with the one you pick. Whether a plan is eligible, and how much allowance it has, is decided by OpenAI — the extension reports what OpenAI says rather than guessing.
- **A local helper for the subscription method** (`helper/`, shipped as its own archive). OpenAI's sign-in for open-source and locally hosted apps accepts only a callback to `127.0.0.1`, which a browser extension cannot receive, so the callback has to be handled by a program on your own computer. The helper is a single folder, has no dependencies, and needs Node.js 20 or later. Run it with `node helper/siwc-helper.js`.
- **The subscription credential never enters the browser.** It is held by the helper in `~/.config/whatsapp-sales-ai-copilot/credentials.json` (`%APPDATA%` on Windows), directory `0700`, file `0600`, written atomically. The extension has no field that could store a token, and tokens are never logged, never placed in the page, and never passed to the WhatsApp content script. Signing out revokes the credential at OpenAI and deletes the file.
- **A connection indicator in the panel header.** It says which AI is answering — the model name, `Sign in`, `Helper off`, `Pick a model` — and clicking it opens the connection settings.
- **A separate test that does not spend anything.** Test Connection checks the helper is running, that you are signed in, and that the model is one your account has. A second, clearly labelled button sends one real short request when you want to check end to end.
- **A second release archive** for the helper, so the path the panel tells you to run is the path you have.
- **A new test suite, `tools/test-helper.js`** (264 assertions, no browser, no network, no account), covering PKCE, the SSE parser, the request body, the loopback request guards, the credential file, the authorize URL, ID-token validation against a real generated RSA keypair, and both halves talking over real HTTP.

### Changed

- **`optional_host_permissions` now includes `http://127.0.0.1/*` again**, this time for the helper. It is requested only when you click **Continue with ChatGPT**, never up front, and only for the loopback origin.
- **Temperature and maximum output tokens are labelled as applying to the API-key method.** OpenAI's flow for open-source clients rejects them, so the subscription path does not offer settings it would then ignore.
- The API-key method is unchanged. Its fields, its request shape and its behaviour are the same as 0.1.0, and the new test suite asserts that the subscription path cannot disturb them.
- Documentation, screenshots and the privacy and security policies now cover both methods.

### Fixed

- The helper now sends the error-code names the extension actually understands. Before this, six of its eight failure codes were unrecognised, so hitting your plan's allowance showed a generic "the request failed" instead of telling you which limit you had reached.
- The helper builds the sign-in callback from the port it is actually listening on, rather than the default port. A helper started with `--port` would previously have sent the browser to an address with nothing behind it.

[Unreleased]: https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.2.0
[0.1.0]: https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.0

## [0.1.0] - 2026-10-10

The first public release of WhatsApp Sales AI Copilot.

### Added

- **Context-aware AI replies.** Read the conversation open in front of you and draft a reply that fits it, instead of starting from a blank composer.
- **Sales follow-ups.** A follow-up action for chasing a customer who has gone quiet, drafted from the same conversation context.
- **Reply in the customer's language.** Draft in the language the conversation is actually happening in.
- **Short, medium and long replies.** Pick the length you need for the moment.
- **Review, edit, send.** Every draft lands in the panel so you can read it, change it, and only then put it into the composer and send it. Nothing is sent without you clicking.
- **Per-chat custom instructions.** Add extra instructions for a particular conversation — how you talk to that customer, what to push, what to avoid — and they are applied to that chat only.
- **Connect your own OpenAI-compatible AI provider.** Enter your own Base URL, API key and model. Any endpoint that speaks OpenAI-compatible `POST /chat/completions` works.
- **Works with 1:1 chats and groups.**

### Changed for the public release

- **Default AI configuration is now empty.** No default provider, no default model, no default key is shipped. You configure the provider yourself; nothing is sent anywhere until you do.
- **The built-in prompt is now generic cross-industry B2B sales**, rather than written for one particular company.
- **A first-run setup screen** walks you through configuring your AI provider the first time you open the panel.
- Follow-up & Send now asks for confirmation before sending without a preview, rather than sending straight away.
- **Tighter manifest permissions.** `optional_host_permissions` is now `["https://*/*", "http://localhost/*"]`. The redundant second loopback entry (`http://127.0.0.1/*`), which existed only for the development test bridge, is gone; the bridge uses `http://localhost/*` instead.

[Unreleased]: https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.0
