# WhatsApp Sales AI Copilot v0.2.0

**Stop rereading chats. Let AI handle the sales follow-up.**

The release that adds a second way to connect an AI: **sign in with a ChatGPT
plan you already pay for**, or keep using your own API key. Both are offered
side by side, and switching between them does not cost you the other one's
settings, your per-chat instructions, or your drafts.

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

## What is new in 0.2.0

### Connect with a ChatGPT plan

Pick **ChatGPT subscription** in the setup screen or in Settings, and the
extension lists the models your account can use. Choose one, and replies are
written with it. Your plan's allowance covers them instead of per-call API
billing.

This method needs a small extra program, and it is worth being straight about
why. OpenAI's sign-in for open-source and locally hosted apps accepts only a
callback to a local address (`127.0.0.1`). A browser extension cannot receive
that callback, and the only redirect a Chrome extension *can* intercept is not
one OpenAI accepts. So the sign-in has to be completed by a process running on
your computer. That process is the helper, and it ships in this release as its
own download.

```
node helper/siwc-helper.js
```

That is the whole installation. It is one folder, it has no dependencies, and it
needs Node.js 20 or later. Then click **Continue with ChatGPT** in the extension
and sign in in the tab that opens.

**Your credential never goes into the browser.** It stays in a file the helper
owns, readable only by your user account. The extension has no field that could
hold a token — not a guarded one, not an encrypted one, none — so there is
nothing for a compromised page or a content script to take. Signing out revokes
the credential at OpenAI and deletes the file.

**Two things this release will not pretend about.** Whether your particular plan
can be used this way is OpenAI's decision, made when you sign in; if it cannot,
the extension tells you so and your API key still works. And a plan is not
unlimited — replies draw on the same allowance you use in ChatGPT, so heavy use
will reach the end of it, and the extension says which limit you hit.

### The API-key method is unchanged

Same fields, same request shape, same behaviour as 0.1.0. The new test suite
asserts that the subscription path cannot disturb it, and switching methods in
either direction leaves the other method's settings exactly where they were.

### Also new

- **A connection indicator in the panel header**, saying which AI is answering:
  the model name, `Sign in`, `Helper off`, `Pick a model`. Click it to open the
  connection settings.
- **A connection test that costs nothing.** **Test Connection** checks the helper
  is running, that you are signed in, and that the model is one your account has.
  A second, clearly labelled button sends one real short request when you want to
  check end to end.
- **Temperature and maximum output tokens are now labelled as API-key settings.**
  OpenAI's flow for open-source clients rejects them, so the subscription path
  does not offer controls it would then ignore.

## Install

1. Download `whatsapp-sales-ai-copilot-0.2.0.zip` from the Assets section below.
2. Unzip it, and **keep the folder** — Chrome reads it from there.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and choose the unzipped folder.

Full walkthrough with pictures, including what Chrome's warning about
non-store extensions means:
[`docs/GETTING_STARTED.md`](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/blob/main/docs/GETTING_STARTED.md).

Then open WhatsApp Web, click the extension icon, and connect your AI provider —
either method.

**Only if you want the ChatGPT subscription method**, also download
`whatsapp-sales-ai-copilot-helper-0.2.0.zip`, unzip it next to the extension
folder, and run:

```
node helper/siwc-helper.js
```

If you use your own API key, you do not need the helper and can ignore that
archive entirely.

## Upgrading from 0.1.0

Nothing to migrate. Your provider, key, model, drafts and per-chat instructions
are where you left them, and the API-key method behaves exactly as before. You
will land on the API-key method, as you were.

## Requirements

- Google Chrome 116 or newer.
- A WhatsApp Web session (the extension automates the one you are already
  signed in to; it does not ask for your password).
- **Either** an OpenAI-compatible AI API and your own key, **or** an eligible
  ChatGPT plan plus Node.js 20 or later for the helper.

## Your data

The conversation text you generate a reply from is sent to **the AI provider you
configure** — your API provider, or OpenAI if you connected a ChatGPT plan — and
nowhere else. Your settings, drafts and per-chat instructions are stored locally
in your browser. If you use the subscription method, the credential is stored by
the helper on your own computer, outside the browser, readable only by your user
account. There is no backend, no analytics, and no account.

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
- The helper has to be running for the ChatGPT subscription method to work. If
  it is not, the extension says so and points at the command to start it.
- Which models the subscription method can use is whatever your account is
  offered, not a list this project chooses.

## Licence

MIT. Not affiliated with, endorsed by or connected to WhatsApp, Meta or OpenAI.
