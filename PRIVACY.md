# Privacy Policy — WhatsApp Sales AI Copilot

**Product:** WhatsApp Sales AI Copilot
**Brand:** Employee Zero
**Version:** 0.1.0
**Repository:** https://github.com/Employee-Zero/whatsapp-sales-ai-copilot

---

## The short version

- The extension reads the WhatsApp Web conversation you currently have open, so it can draft a reply for you.
- To write that reply, it sends the conversation text to **the AI provider you configured yourself**. That text leaves your computer and goes to that provider. It does not come to us. There is no "us" — this project has no server.
- Your API key and your drafts are stored inside your own browser profile on your own computer.
- There is no analytics, no telemetry, no advertising, no account and no subscription. The extension never phones home, because there is no home to phone.
- You are the one responsible for your customers' data and for the rules that apply to your business. Please read the section "Your responsibilities" below.

---

## What the extension reads

The extension only works on `https://web.whatsapp.com/*`, and only when you are already logged in to WhatsApp Web in your own browser.

When you have a conversation open, the extension reads what WhatsApp has **already rendered** in the page — the messages visible in the open chat — so that it can build context for a suggested reply. Specifically:

- It reads the currently open 1:1 chat or group conversation.
- It does **not** scroll the conversation to load older history. It only sees what WhatsApp has already put on screen.
- It does **not** scan your chat list, your contact list, or any other conversation. It does not read chats you have not opened.
- It does not read anything on any website other than WhatsApp Web.

This reading is read-only. The only thing the extension ever writes into the page is described under "What it can do in your browser" below.

---

## What leaves your computer, and where it goes

To generate a reply, the extension sends the conversation text to **the AI provider that you configured yourself**.

- You choose that provider. You type in its Base URL (any OpenAI-compatible `POST /chat/completions` endpoint), your API key for it, and the model name.
- **This project does not ship a default provider, a default model, or a default key.** Out of the box, no AI provider is configured and nothing is sent anywhere.
- The request goes **directly from your browser to the endpoint you entered**. It does not pass through the project, through the authors, or through any intermediary service operated by this project. There is no server in this project to pass through.
- What that provider then does with the text — how long it keeps it, whether it trains on it, where it stores it, who can access it — is governed by **that provider's own privacy policy and terms**, not by this document. Please read them. If you handle customer data, read them carefully before you pick a provider.

Once the text has been sent, this project has no visibility into it and no ability to recall or delete it.

**So: chat data does not always stay on your machine.** Anything you send for a reply leaves your machine and goes to your chosen AI provider. Everything *else* — your configuration, your drafts, your stored messages — stays local.

---

## What is stored locally

The extension stores the following in `chrome.storage.local`, which is inside your own Chrome profile on your own computer:

- **AI configuration** — the Base URL, the model name, and your API key.
- **`messageStore`** — accumulated message history, per chat, used to give the AI context.
- **`drafts`** — your unsent drafts, per chat.
- **`instructions`** — any extra instructions you have added for a particular chat.
- **`onboarding`** — a small flag recording that you have seen the first-run setup screen.

This data is **local to that browser profile**. The extension does not sync it to any cloud service, and it is not sent to the project.

You can remove all of it at any time:

- **Uninstalling the extension** removes its storage.
- **Clearing the extension's storage** (for example, from Chrome's extension settings, or by removing and re-adding the extension) also removes it.

---

## About your API key

Your API key is stored in `chrome.storage.local` — that is, in your browser profile.

- The key is only ever placed in the `Authorization: Bearer …` header of the request to the endpoint **you** configured.
- It is never logged, never displayed in the side panel (the panel only shows a masked hint that a key is present), and never sent back to the side panel.
- **Anything that can read your browser profile can read your key.** That includes anyone with filesystem access to your computer, anyone who can run code as your user, malware, and anyone who copies or syncs that profile. The key is not encrypted by the extension. Treat it like any other credential stored on your machine, use a key scoped to only what you need, and revoke it at your provider if you think it has been exposed.

---

## What the extension can do in your browser

Beyond reading the open conversation, the extension can write a drafted message into the WhatsApp composer box and click WhatsApp's own Send button.

- It does **not** send anything on its own. Nothing is sent unless you click a button in the panel.
- The Follow-up & Send action asks you for confirmation before sending a message that you have not previewed.
- It does not send to a recipient you did not choose: it writes into the chat that is open in front of you.

---

## What the project does NOT do

- **No analytics.** Nothing is measured, counted or reported.
- **No telemetry.** No usage data, no crash data, no diagnostics leave your browser for this project.
- **No advertising.** No ads, no ad networks, no tracking pixels.
- **No account.** There is nothing to sign up for, and no login.
- **No server.** There is no backend, no database and no author-operated service of any kind. There is nowhere for your data to be collected, because no such place exists.
- **No subscription and no payment.** Nothing is billed.
- **No sale or sharing of your data** by this project, because this project never receives it in the first place.

---

## Your responsibilities

You are using this extension on conversations with **your customers**. That makes you the one handling their data, and it makes you responsible for what happens to it.

- **You are responsible for your customers' data.** Think about what you are about to send to an AI provider before you send it.
- **You are responsible for your legal obligations.** Depending on where you and your customers are, rules such as the GDPR, the UK GDPR, other data protection laws, sector regulations, and your own contracts with customers may apply to the conversation text you send to an AI provider and to the drafts you store. Whether, and how, those rules apply to you is a question for you and, if needed, your own adviser — this document does not decide it for you and is not legal advice.
- **You are responsible for the AI provider you choose.** Its privacy policy governs what it does with the text you send it. Choose a provider whose terms you can actually live with, and configure it accordingly.

---

## Affiliation

This extension is **not affiliated with, endorsed by, or authorised by WhatsApp, Meta, or any AI provider.** It is an independent tool that automates your own browser session using the WhatsApp Web page's DOM.

That approach may be affected by WhatsApp's terms of service, and it can break if WhatsApp changes its page. **You are responsible for complying with the terms that apply to you.** We are describing the situation rather than giving you a legal conclusion, and we make no claim here that your particular use complies with any particular terms. Please read the terms that apply to you and make your own judgement.

---

## Changes to this document

This is version 0.1.0, the first public release. If this document changes in a future version, the change will be recorded in `CHANGELOG.md` in the repository.
