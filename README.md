# WhatsApp Sales AI Copilot

**Better WhatsApp replies. Less typing.**

A free, open-source Chrome extension that helps salespeople write replies and follow up with customers, right inside WhatsApp Web.

**[Download the extension ↓](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)** · [Quick installation guide](docs/GETTING_STARTED.md)

<a href="docs/assets/04-generated-draft.png"><img src="docs/assets/04-generated-draft.png" alt="AI reply draft in the WhatsApp Sales AI Copilot side panel (demo)" width="340"></a>

*Demo conversation — no real customer data.*

## What can it do?

- **Write replies using chat context** — based on the messages currently loaded in WhatsApp Web.
- **Help with sales follow-ups** — without awkward, generic check-ins.
- **Reply in the customer's language** when it's clear from the conversation.
- **Make replies your own** — choose Short / Medium / Long, add a note for a specific customer, or edit the draft.
- **Send when you're ready** — review and click **Send**. An optional **Follow-up & Send** action sends without preview, with an explicit confirmation first.

## Get started

1. **[Download the latest ZIP](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)** and extract it. Keep the extracted folder.
2. Open `chrome://extensions` in Chrome, enable **Developer mode**, click **Load unpacked**, and select that folder.
3. Open [WhatsApp Web](https://web.whatsapp.com), then open the extension's side panel.
4. Add your own **API Base URL**, **API Key**, and **Model ID**. Click **Test Connection**, then **Save & Continue**.
5. Open a customer chat → **Generate Reply** → review or edit → **Send**.

**[Step-by-step guide with pictures →](docs/GETTING_STARTED.md)**

<a href="docs/assets/01-first-run-setup.png"><img src="docs/assets/01-first-run-setup.png" alt="First-time AI setup screen (demo)" width="320"></a>

## Bring your own AI

You need an API key from a provider with an **OpenAI-compatible Chat Completions API**. This extension does **not** include an AI service or API credits. Your provider may charge for usage. The fallback API URL is optional.

## Privacy & limitations

Your conversation text is sent to **the AI provider you configure** when you request a reply. Your API key and drafts are stored in your Chrome extension storage. Use the tool only when appropriate for your customers' data and your company's policies. [Read the privacy details](PRIVACY.md).

This is **not** a bulk messenger, scheduled follow-up system, or CRM. It reads the current loaded text conversation, not every historical message or attachment. It is an independent project, **not affiliated with WhatsApp or Meta**.

## Help & development

[Installation help](docs/GETTING_STARTED.md) · [Report an issue](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/issues) · [For developers](docs/DEVELOPMENT.md) · [Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

MIT License · [Employee Zero](https://github.com/Employee-Zero)
