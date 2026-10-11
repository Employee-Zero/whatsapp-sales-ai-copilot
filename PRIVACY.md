# Privacy Policy — WhatsApp Sales AI Copilot

**Product:** WhatsApp Sales AI Copilot
**Brand:** Employee Zero
**Version:** 0.2.0
**Repository:** https://github.com/Employee-Zero/whatsapp-sales-ai-copilot

---

## The short version

- The extension reads the WhatsApp Web conversation you currently have open, so it can draft a reply for you.
- To write that reply, it sends the conversation text to **the AI provider you configured yourself**. That text leaves your computer and goes to that provider. It does not come to us. There is no "us" — this project has no server.
- There are two ways to configure a provider. You can enter an API key for any OpenAI-compatible service, or you can connect a ChatGPT plan through a small helper program that runs on your own computer. Either way, what leaves your machine goes to the company you chose, under their policy.
- If you use an API key, the key and your drafts are stored inside your own browser profile on your own computer.
- If you connect a ChatGPT plan, the sign-in credential is **not** stored in your browser at all. It is stored by the helper, in a file on your own computer that only your user account can read. The extension has no field that could hold a token.
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

- You choose that provider. With the API-key method you type in its Base URL (any OpenAI-compatible `POST /chat/completions` endpoint), your API key for it, and the model name. With the ChatGPT method you sign in to OpenAI and pick from the models your account can use.
- **This project does not ship a default provider, a default model, or a default key.** Out of the box, no AI provider is configured and nothing is sent anywhere.
- The request goes to the endpoint you configured. It does not pass through the project, through the authors, or through any intermediary service operated by this project. There is no server in this project to pass through.
- **Exactly one destination is ever used at a time** — the one the selected method points at. Choosing the ChatGPT method does not also send anything to an API provider, and choosing an API provider does not send anything to OpenAI.
- What that provider then does with the text — how long it keeps it, whether it trains on it, where it stores it, who can access it — is governed by **that provider's own privacy policy and terms**, not by this document. Please read them. If you handle customer data, read them carefully before you pick a provider.

Once the text has been sent, this project has no visibility into it and no ability to recall or delete it.

**So: chat data does not always stay on your machine.** Anything you send for a reply leaves your machine and goes to your chosen AI provider. Everything *else* — your configuration, your drafts, your stored messages — stays local.

---

## If you connect a ChatGPT plan

This method involves a second program, and it is worth being precise about what it is and what it holds.

**Why it exists.** OpenAI's sign-in for open-source and locally hosted apps accepts only a callback to a local address (`127.0.0.1`). A browser extension cannot receive that callback, so the sign-in has to be completed by a process on your computer. That process is the helper, which is part of this repository and which you run yourself.

**What it holds.** One file: `~/.config/whatsapp-sales-ai-copilot/credentials.json` on macOS and Linux, or `%APPDATA%\whatsapp-sales-ai-copilot\credentials.json` on Windows. It contains the access token, the refresh token, the ID token, the client ID OpenAI issued to this installation, and the account's email address as a label. The directory is created readable only by your user account (`0700`) and the file likewise (`0600`). On Windows those POSIX modes do not apply and the file inherits your user profile's permissions; the helper's `--status` command tells you which of the two happened.

**What it does not hold.** The extension's browser storage never contains a token, and the extension has no field capable of storing one. Tokens are not written to the page, not passed to the WhatsApp content script, and not logged — not by the extension and not by the helper. The helper's own log lines name the account's email label and nothing else.

**Who it talks to.** Two hosts, and only two: `auth.openai.com` for the sign-in itself, and `api.openai.com` for the model list and for replies. It does not read your browser cookies, does not use your ChatGPT web session, and does not call any ChatGPT-internal endpoint. It listens on `127.0.0.1` only — never on your local network — and refuses requests that do not come from this extension.

**Your conversation text goes to OpenAI under this method**, because OpenAI is the provider you selected. The same caveats as above apply: their policy governs what happens to it.

**Removing it.** Signing out from the extension revokes the credential at OpenAI and deletes the file. Deleting the file by hand also works — the helper will simply ask you to sign in again. Deleting the folder and the helper program removes the method entirely; the API-key method is unaffected.

---

## What is stored locally

The extension stores the following in `chrome.storage.local`, which is inside your own Chrome profile on your own computer:

- **AI configuration** — which connection method you chose, the Base URL, the model name, and your API key (API-key method only), plus the address of the local helper (ChatGPT method only).
- **`messageStore`** — accumulated message history, per chat, used to give the AI context.
- **`drafts`** — your unsent drafts, per chat.
- **`instructions`** — any extra instructions you have added for a particular chat.
- **`onboarding`** — a small flag recording that you have seen the first-run setup screen.

Note what is **not** in that list: no ChatGPT access token, no refresh token, no session cookie, and no password. The ChatGPT method's credential is not in your browser at all — see the section above.

Separately, and only if you use the ChatGPT method, the helper keeps its credential file as described above. That file is outside the browser and is not touched by installing, updating or removing the extension.

This data is **local to that browser profile**. The extension does not sync it to any cloud service, and it is not sent to the project.

You can remove all of it at any time:

- **Uninstalling the extension** removes its storage. It does not remove the helper's credential file; sign out first if you want that revoked at OpenAI as well.
- **Clearing the extension's storage** (for example, from Chrome's extension settings, or by removing and re-adding the extension) also removes it.

---

## About your API key

Your API key is stored in `chrome.storage.local` — that is, in your browser profile. This applies to the API-key method only; the ChatGPT method stores no key anywhere.

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
- **No account.** There is nothing to sign up for, and no login to this project.
- **No server.** There is no backend, no database and no author-operated service of any kind — including for the ChatGPT method. The helper runs on your computer and talks to OpenAI directly; it does not report to us, and there is nowhere for it to report to.
- **No subscription and no payment.** Nothing is billed by this project. What you pay your AI provider, or what your ChatGPT plan costs, is between you and them.
- **No sale or sharing of your data** by this project, because this project never receives it in the first place.

---

## Your responsibilities

You are using this extension on conversations with **your customers**. That makes you the one handling their data, and it makes you responsible for what happens to it.

- **You are responsible for your customers' data.** Think about what you are about to send to an AI provider before you send it.
- **You are responsible for your legal obligations.** Depending on where you and your customers are, rules such as the GDPR, the UK GDPR, other data protection laws, sector regulations, and your own contracts with customers may apply to the conversation text you send to an AI provider and to the drafts you store. Whether, and how, those rules apply to you is a question for you and, if needed, your own adviser — this document does not decide it for you and is not legal advice.
- **You are responsible for the AI provider you choose.** Its privacy policy governs what it does with the text you send it. Choose a provider whose terms you can actually live with, and configure it accordingly. If you connect a ChatGPT plan, OpenAI is that provider.
- **You are responsible for the machine the helper runs on.** Its credential file is a live credential for your ChatGPT account. Treat the computer as you would treat a signed-in browser, and sign out if you are giving the machine away.

---

## Affiliation

This extension is **not affiliated with, endorsed by, or authorised by WhatsApp, Meta, OpenAI, or any AI provider.** It is an independent tool that automates your own browser session using the WhatsApp Web page's DOM, and — for the subscription method — signs in to your own OpenAI account using the sign-in OpenAI publishes for open-source and locally hosted apps.

The browser-automation approach may be affected by WhatsApp's terms of service, and it can break if WhatsApp changes its page. **You are responsible for complying with the terms that apply to you.** We are describing the situation rather than giving you a legal conclusion, and we make no claim here that your particular use complies with any particular terms. Please read the terms that apply to you and make your own judgement.

Nothing in this project grants you access to a ChatGPT plan you are not entitled to. Whether your plan can be used this way is decided by OpenAI when you sign in, not by this extension.

---

## Changes to this document

This is version 0.2.0. It added the section on the ChatGPT subscription method and corrected the storage list to say what that method does and does not put in your browser. If this document changes in a future version, the change will be recorded in `CHANGELOG.md` in the repository.
