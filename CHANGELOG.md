# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
