# WhatsApp Sales AI Copilot v0.1.0

**Your first employee isn't human.**

The first public release. An AI copilot that sits beside your WhatsApp Web
conversation, reads it, and writes the next reply — so you can spend your time
on the customer instead of on the blank message box.

## What it does

- **Replies that fit the conversation.** It reads the chat you have open and
  drafts a reply to what the customer actually asked, instead of starting from
  nothing.
- **Follow-ups for quiet customers.** One action for the "let me think about it"
  thread you have been avoiding.
- **In the customer's language.** It replies in the language the conversation is
  happening in.
- **You always see it first.** The draft lands in the side panel as an editable
  box. Nothing reaches the customer until you put it in the composer and send it
  yourself.
- **Length control.** Short, medium or long, per message.
- **One instruction per customer.** Notes that apply to a single conversation —
  what you quoted them, what they are waiting on, what not to bring up — saved
  per chat.
- **1:1 chats and groups.**

## What is new in 0.1.0

This is the first release, so everything is new. The parts worth knowing about:

- **You bring your own AI provider.** The extension ships with no default
  provider, no default model and no key. On first run it asks for an API Base
  URL, an API Key and a Model ID — any OpenAI-compatible endpoint works — and
  it sends nothing anywhere until you have filled them in.
- **A first-run screen that explains itself.** Three required fields, a
  "Where do I find these details?" answer, a **Test Connection** button, and
  then a short "what to do next" that appears once and stays dismissed.
- **Follow-up & Send asks first.** Because it sends without showing you the
  draft, it now names the person it is about to message and waits for you to
  confirm.

## Install

1. Download `whatsapp-sales-ai-copilot-0.1.0.zip` from the Assets section below.
2. Unzip it, and **keep the folder** — Chrome reads it from there.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and choose the unzipped folder.

Full walkthrough with pictures, including what Chrome's warning about
non-store extensions means:
[`docs/GETTING_STARTED.md`](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/blob/main/docs/GETTING_STARTED.md).

Then open WhatsApp Web, click the extension icon, and connect your AI provider.

## Requirements

- Google Chrome 116 or newer.
- A WhatsApp Web session (the extension automates the one you are already
  signed in to; it does not ask for your password).
- An OpenAI-compatible AI API and your own key.

## Your data

The conversation text you generate a reply from is sent to **the AI provider you
configure**, and nowhere else. Your settings, drafts and per-chat instructions
are stored locally in your browser. There is no backend, no analytics, and no
account.

Read [`PRIVACY.md`](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/blob/main/PRIVACY.md)
for the details, and
[`SECURITY.md`](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/blob/main/SECURITY.md)
for how to report a problem.

## Known limits

- The extension reads the WhatsApp Web page to do its job. When WhatsApp
  changes its markup, reading a chat can break until the extension is updated.
- Only the messages already loaded in the open conversation are used. It does
  not scroll back through history, and it does not read any other chat.
- It does not send anything by itself, with the single exception of
  **Follow-up & Send**, which asks for confirmation first.

## Licence

MIT. Not affiliated with, endorsed by or connected to WhatsApp, Meta or any AI
provider.
