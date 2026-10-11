# WhatsApp Sales AI Copilot — Chrome Extension

**Stop rereading chats. Let AI handle your sales follow-ups.**

An open-source Chrome extension that helps salespeople understand past WhatsApp conversations and generate relevant replies and follow-ups — without copying and pasting.

**[Download Extension](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)** · **[Installation Guide](docs/GETTING_STARTED.md)**

<table>
<tr>
<td align="center"><a href="docs/assets/04-generated-draft.png"><img src="docs/assets/04-generated-draft.png" alt="AI-generated sales reply (demo conversation)" width="210"></a><br><sub>AI Replies</sub></td>
<td align="center"><a href="docs/assets/05-per-chat-instruction.png"><img src="docs/assets/05-per-chat-instruction.png" alt="Custom instruction for a customer (demo)" width="210"></a><br><sub>Custom Instructions</sub></td>
<td align="center"><a href="docs/assets/06-followup-confirmation.png"><img src="docs/assets/06-followup-confirmation.png" alt="Follow-up send confirmation (demo)" width="210"></a><br><sub>Follow-ups</sub></td>
</tr>
</table>

*Real extension screenshots with fictional conversations. Click an image to enlarge.*

## Why We Built This

In B2B sales, customer conversations pile up quickly.

When you follow up weeks or months later, it's easy to forget what the customer needed, what you discussed, or where you left off.

AI made writing replies easier, but repeatedly copying WhatsApp conversations into AI tools was still slow and frustrating.

**That's why we built this extension — to bring AI directly into WhatsApp Web and eliminate the endless copy-paste.**

## What It Does

**1. Read Conversations in One Click**

Capture messages from your current WhatsApp Web conversation. Need more history? Simply scroll up to load older messages before generating a reply.

**2. Customize AI for Your Business**

Set your own AI prompt to match your industry, products, and sales style. Add specific instructions for individual customers.

**3. Generate Better Replies and Follow-ups**

Create natural, context-aware replies based on your conversations. Choose the length, edit the draft, and send when you're ready.

**Less reading. Less copying. More selling.**

## Get Started

1. **Download** the latest ZIP and unzip it.
2. **Install** it in Chrome: `chrome://extensions` → Developer mode → Load unpacked.
3. **Connect your AI** using your API Base URL, API Key, and Model ID.
4. **Start replying** — open a WhatsApp conversation, generate a reply, review, and send.

**[Step-by-Step Installation Guide →](docs/GETTING_STARTED.md)**

## AI Setup & Cost

**The extension is free and open source. AI replies require your own API key.**

Connect an OpenAI-compatible AI provider of your choice. Your provider may charge for API usage.

New to AI APIs? Our [Installation Guide](docs/GETTING_STARTED.md#step-3--connect-your-ai) explains how to get an API key and set everything up.

*Note: A ChatGPT subscription does not include API credits.*

## Good to Know

- Chat messages are sent to your chosen AI provider when you generate a reply.
- Only messages currently loaded in WhatsApp Web are available to the extension.
- No CRM integration, bulk messaging, or scheduled follow-ups.
- This is an independent open-source project, not affiliated with WhatsApp or Meta.

[Privacy](PRIVACY.md) · [For Developers](docs/DEVELOPMENT.md) · [Report an Issue](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/issues) · [MIT License](LICENSE)

**Employee Zero — Your first employee isn't human.**
