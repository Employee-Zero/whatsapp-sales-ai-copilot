# WhatsApp Sales AI Copilot — Chrome Extension

**Stop rereading chats. Let AI handle the sales follow-up.**

An open-source Chrome extension that helps salespeople understand past WhatsApp conversations and generate relevant replies and follow-ups — without copying and pasting.

## Use your ChatGPT Plus or Pro subscription — no API key required

**Free and open source.** Connect the ChatGPT Plus or Pro plan you already pay for, or use your own API key. Two ways to connect, one extension:

- **ChatGPT (recommended)** — sign in with your ChatGPT Plus or Pro subscription. No API key needed. This needs **ChatGPT Connector**, a small free macOS app made by Employee Zero (Apple Silicon Macs only), which handles the sign-in on your own computer.
- **API Key** — works on its own, on any computer Chrome runs on, with any OpenAI-compatible provider. No Connector, no ChatGPT subscription.
- **Optional backup:** if you use ChatGPT, you can turn on *Use API Key as backup* (off by default). Then, only when ChatGPT is out of allowance or temporarily unavailable, your API provider answers instead.

**[Download the Chrome extension](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)** (required) · **[Installation Guide](docs/GETTING_STARTED.md)** · For ChatGPT on a Mac, also get **[ChatGPT Connector](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/download/v0.1.2/ChatGPT-Connector-for-Sales-AI-Copilot-macOS-arm64.pkg)** (a separate download, only needed for ChatGPT; it is published with release [v0.1.2](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.2) and is compatible with later extension versions).

<a href="docs/assets/04-generated-draft.png"><img src="docs/assets/04-generated-draft.png" alt="AI-generated sales reply (demo conversation)" width="260"></a>

*Screenshot with a fictional conversation, from an earlier build — some labels have since changed.*

## Why We Built This

In B2B sales, customer conversations pile up quickly.

When you follow up weeks or months later, it's easy to forget what the customer needed, what you discussed, or where you left off.

AI made writing replies easier, but repeatedly copying WhatsApp conversations into AI tools was still slow and frustrating.

**That's why we built this extension — to bring AI directly into WhatsApp Web and eliminate the endless copy-paste.**

## What It Does

**1. Read Conversations in One Click**

Capture messages from your current WhatsApp Web conversation. Need more history? Simply scroll up to load older messages before generating a reply.

**2. Customize AI for Your Business**

Set your own AI prompt to match your industry, products, and sales style. Add a one-off tip for a specific message.

**3. Generate Better Replies and Follow-ups**

Create natural, context-aware replies based on your conversations. Choose the length, edit the draft, and send when you're ready.

**Less reading. Less copying. More selling.**

## Get Started

1. **Download the Chrome extension** first (the ZIP named `…Chrome-Extension…`) from the [latest release](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest), unzip it, and install it: `chrome://extensions` → Developer mode → Load unpacked.
2. **Open the extension on WhatsApp Web** and choose how to connect:
   - **ChatGPT** — follow the three steps in the panel: *Install ChatGPT Connector* → *Allow Local Access* → *Continue with ChatGPT*. Requires ChatGPT Plus or Pro and a Mac with Apple silicon.
   - **API Key** — enter your API Base URL, API Key and Model ID. Nothing else to install.
3. **Generate a reply**, review or edit it, then send.

Step-by-step with the macOS security prompt explained: **[Installation Guide](docs/GETTING_STARTED.md)**.

## Cost

**The extension is free and open source.**

- **ChatGPT:** replies use your ChatGPT plan's allowance. Whether your plan can be used this way is decided by OpenAI when you sign in — this project cannot promise it.
- **API Key:** your provider charges you at its own rates.
- **They are separate.** A ChatGPT subscription is not API credit, and having a ChatGPT subscription does not make a third-party API free (or the other way round).

## Good to Know

- Chat messages are sent to the AI provider you chose when you generate a reply — OpenAI if you use ChatGPT, or your API provider with an API Key. If you turn on the API Key backup, a reply can go to your API provider when ChatGPT is unavailable.
- With ChatGPT, your sign-in is held by ChatGPT Connector on your own Mac, in a file only your user account can read — never in browser storage, never logged, never sent to WhatsApp.
- Only messages currently loaded in WhatsApp Web are available to the extension.
- No CRM integration, bulk messaging, or scheduled follow-ups.
- This is an independent open-source project, not affiliated with WhatsApp, Meta, or OpenAI. ChatGPT Connector is made by Employee Zero and is not an OpenAI product. Its macOS installer is not signed with an Apple Developer ID or notarized; the guide shows how to open it safely.

[Privacy](PRIVACY.md) · [Security](SECURITY.md) · [For Developers](docs/DEVELOPMENT.md) · [Report an Issue](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/issues) · [MIT License](LICENSE)

**Employee Zero — Your first employee isn't human.**
