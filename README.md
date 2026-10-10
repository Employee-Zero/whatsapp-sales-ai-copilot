# WhatsApp Sales AI Copilot

**Your first employee isn't human.**

An AI assistant that sits next to your WhatsApp Web and helps you reply to customers —
and follow up on the ones who went quiet.

You read the conversation, it writes the reply, you decide whether to send it.
Nothing goes out until you click.

**[Download the latest version →](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)**

---

## Contents

1. [What this is](#1-what-this-is)
2. [Who it's for](#2-who-its-for)
3. [What it does](#3-what-it-does)
4. [Install it](#4-install-it)
5. [Connect your AI](#5-connect-your-ai)
6. [Your first reply](#6-your-first-reply)
7. [Following up on a quiet customer](#7-following-up-on-a-quiet-customer)
8. [Getting better replies](#8-getting-better-replies)
9. [Your data and your customers' data](#9-your-data-and-your-customers-data)
10. [When something goes wrong](#10-when-something-goes-wrong)
11. [What it does not do](#11-what-it-does-not-do)
12. [For Developers](#12-for-developers)

---

## 1. What this is

A small tool that lives inside your Chrome browser, next to WhatsApp Web.

It reads the conversation you already have open, and writes a reply for you.
You can edit that reply before it goes anywhere. Or you can tell it to follow up
on a customer who hasn't answered in a while.

Think of it as a colleague who has read every message in the thread, knows what
you're selling, and types faster than you do — but never presses Send on their own.

**What it is not:** it isn't a chatbot, it isn't a bulk-messaging tool, and it
doesn't reply to customers automatically. You stay in the conversation. It just
removes the blank-page problem.

---

## 2. Who it's for

Salespeople who sell to businesses over WhatsApp, and who write every message
themselves.

You'll get the most out of it if:

- You have real conversations with customers — questions, quotes, follow-ups,
  people going quiet for two weeks.
- You sell something that needs explaining. Machines, equipment, materials,
  software, services. Things where the reply isn't "yes" or "no".
- You write in more than one language. Your customers write in theirs, and you
  can reply in theirs without reaching for a translator.
- You don't have a marketing team writing your messages for you.

You'll get less out of it if you send the same three lines to everybody.
It's built for conversations, not campaigns.

### What you need before you start

- A computer with **Google Chrome** on it.
- A WhatsApp account that's already logged into **WhatsApp Web** on that computer.
- An **API key** from an AI provider. This is the one part that isn't free —
  see [Connect your AI](#5-connect-your-ai). It usually costs a few dollars a
  month for a normal sales workload, billed by the provider directly to you.

You do **not** need: a server, a subscription to this project, an account with us,
or any technical knowledge. There is nothing to run and nothing to maintain.

---

## 3. What it does

| | |
|---|---|
| **Writes the reply** | Reads the conversation you have open and drafts a reply that continues it properly — not a generic greeting. |
| **Knows the thread** | It sees who said what, so it answers the actual question the customer asked, not the one before it. |
| **Replies in their language** | Customer writes in Spanish, you get Spanish. You don't have to ask. |
| **Short, medium or long** | A one-line confirmation and a full quotation explanation are different jobs. Pick per message. |
| **You review before sending** | The draft lands in the box. Edit it, rewrite it, throw it away. Send is your click. |
| **Follow-up in one click** | For a customer you know well: read the thread and send a follow-up without stopping to review. |
| **One instruction per customer** | "Ask how the installation went." Applies to that customer only. |
| **Keeps your place** | You write a draft for Customer A, get interrupted by Customer B, come back — your A draft is still there. |
| **Bring your own AI** | Any OpenAI-compatible provider. Your key, your account, your bill. |

---

## 4. Install it

**Full walkthrough with pictures: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** —
written for people who have never used a Terminal. Read that one if any of the
steps below look unfamiliar.

The short version:

1. Go to the **[Releases page](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)**
   and download the file ending in `.zip`.
2. **Unzip it.** You'll get a folder. Move that folder somewhere permanent —
   your Documents folder is fine. **Don't delete it afterwards:** Chrome reads
   the extension from that folder every time it starts. If you move or delete it,
   the extension stops working.
3. Open Chrome and type `chrome://extensions` in the address bar.
4. Turn on **Developer mode** — the switch in the top-right corner.
5. Click **Load unpacked** and select the folder you unzipped.
6. Chrome will show a warning and ask you to confirm. This is normal, and here's
   the honest reason: Chrome shows that warning for **any** extension that wasn't
   installed from the Chrome Web Store. It is not a virus warning and it doesn't
   mean anything was found wrong with this one — it means Chrome can't vouch for
   extensions it hasn't reviewed. You're installing from source you can read.
7. Pin it: click the puzzle-piece icon in Chrome's toolbar and click the pin next
   to **WhatsApp Sales AI Copilot**.

Chrome updates extensions it installed from the Web Store automatically. This one
it can't — so when a new version comes out, download the new ZIP, replace the
folder, and click the reload arrow on `chrome://extensions`.

---

## 5. Connect your AI

This is the only setup step, and you only do it once.

Open WhatsApp Web, click the extension icon, and the panel opens on the right.
The first time, it shows a welcome screen asking for three things:

**API Base URL** · **API Key** · **Model ID**

These come from your AI provider, not from us. We don't ship a default and we
don't have an account to lend you — the extension talks directly to whichever
provider you choose, and the bill goes to you.

### Where to find them

Any provider that offers an **OpenAI-compatible API** will work. That's most of
them. Popular choices include OpenAI itself, OpenRouter, Together, DeepSeek,
Groq, or a self-hosted setup like Ollama or vLLM.

When you sign up, the provider gives you a page — usually called "API keys" or
"Dashboard" — with all three values on it:

- The **Base URL** looks like `https://api.something.com/v1`. Copy the part
  before `/chat/completions` if they show you the full endpoint.
- The **API Key** is a long string of letters and numbers. It may start with
  `sk-` or it may not. Either is fine — paste it exactly as given.
- The **Model ID** is the name of the model, like `gpt-4o-mini` or
  `claude-sonnet-5-5`. It's on the provider's model list page. Copy it exactly;
  it's usually lowercase with dashes.

Click **Test Connection** before you save. It sends one tiny request and tells you
exactly what's wrong if something is — a wrong key, a typo'd URL, a model name
that doesn't exist. Fix it until it says the connection works, then click
**Save & Continue**.

That's it. The welcome screen won't come back.

> **A note on cost.** You're billed by your provider, per message. A reply costs
> a fraction of a cent on most models. If you want to keep it cheap, pick a
> smaller model — for sales replies the difference is rarely noticeable.

> **You can change any of this later.** Click the gear icon at the top of the
> panel to reopen these settings at any time.

---

## 6. Your first reply

1. **Open the conversation** you want to reply to, in WhatsApp Web.
2. **Click the extension icon.** The panel opens on the right and picks up the
   conversation you're looking at.
3. **Click Generate Reply.** A draft appears in the lower box.
4. **Read it and edit it.** Click into the box and change whatever you want.
   It's a text box, not a contract.
5. **Click Send.**

The message goes into the WhatsApp input box and sends, exactly as if you'd typed
it. If you'd rather send it by hand, just copy it — or leave the draft there and
edit it in WhatsApp directly.

**The two boxes are colour-coded, and it matters:**

- **Green** is the AI's output — the draft that could go to your customer.
- **Amber** is your input to the AI — the instruction that steers it.

They look different on purpose. One of them gets sent.

### Short, Medium or Long

Under the draft box there's a length selector. **Medium** is right most of the
time. Use **Short** for confirmations and logistics, **Long** when you're
explaining a quote, a spec, or why your lead time is what it is. Your choice is
remembered between messages.

---

## 7. Following up on a quiet customer

Every salesperson has a list of people who said "let me think about it" three
weeks ago.

For a customer you know well, there's **Follow-up & Send** at the bottom of the
panel. It reads the thread, writes a follow-up, and sends it — in one click,
without showing you the draft first.

That's the point of it: it's for the customer where you already know what the
message should say and you just haven't sent it.

Because it sends without a preview, clicking it asks you to confirm first, and it
shows you who you're about to message:

> **Send without showing you the message first?**
> The AI will read this conversation, write a reply and send it straight to
> **Dana Whitfield**. You will not get to read or edit it.
> [ Cancel ] [ Generate & Send ]

![The follow-up confirmation, naming the recipient and warning that you will not
see the message first](docs/assets/06-followup-confirmation.png)

Read that name before you click. If it isn't who you meant to message, cancel.

> **About the screenshots in this README and in the install guide.** Every
> picture is a demonstration, not a real conversation. The contact
> ("Dana Whitfield" and the reserved fictional number `+1 555 010 0000`), the
> company, the messages, the draft and the API details shown in the settings
> screens are all invented. They are rendered from the real panel by
> `tools/shoot.js` in a throwaway Chrome profile that is not signed in to
> WhatsApp, so no customer's conversation, phone number or API key can appear in
> one. `docs/assets/` is the only place images live.

**If you want to see the message first — which is most of the time — use
Generate Reply instead.** It does the same reading and writing, and then stops
and waits for you.

---

## 8. Getting better replies

The default prompt is written for general B2B sales. You'll probably want to
adjust it, and you should — it's the single biggest improvement available.

**Click the gear icon → "How the AI should write".** This is the instruction the
AI gets on every single message. Put your company's reality in it:

- What you sell, in your customer's words.
- How you talk — formal or casual, technical or plain.
- Your rules. "Never quote a price without checking stock." "Always ask for the
  quantity before discussing lead time." "Sign off with the company name."
- What to avoid. "Don't use exclamation marks." "Never say 'Dear'."

There's a **Reset to default** button if you get lost.

![The settings pane, with the AI writing instruction and the provider
fields](docs/assets/07-settings.png)

### One instruction for one customer

The default prompt is about your company. But "ask how the trial installation
went" is only true for one customer. That's what the **Add an instruction for this
chat** line is for — anything you type there applies to that conversation only.
Switch to a different customer and you'll see theirs instead.

It's saved per customer, so it's still there next week. Use it for what you'd
otherwise have to explain every time: what you quoted them, what they're
waiting on, what not to bring up.

![A per-chat instruction typed into the "Add an instruction for this chat"
line](docs/assets/05-per-chat-instruction.png)

### A few things that help

- **Give it something to work with.** If the thread is one word long, the reply
  will be generic. That's true of human assistants too.
- **Edit the draft, don't regenerate it.** If the draft is 80% right, fixing the
  last sentence is faster than rolling the dice again.
- **Read before you send.** The AI has read the conversation. It hasn't read the
  customer's tone of voice, the phone call you had yesterday, or the fact that
  they're annoyed. You have.

---

## 9. Your data and your customers' data

Worth two minutes of your attention, because this involves other people's
messages.

**Where things go:**

- The extension has **no server of ours**. There's no account, no analytics, no
  tracking, nothing phoning home to the project.
- When you click Generate Reply, the conversation text goes from your browser to
  **the AI provider you configured** — the one whose key you pasted in. It goes
  there and nowhere else. That provider's privacy policy applies to it, not ours,
  so it's worth knowing what they do with data.
- Your API key, your settings, your drafts and your per-customer instructions are
  stored **locally in your Chrome profile**, on your computer. Not synced, not
  uploaded.

**What that means in practice:** you are the one deciding to send customer
messages to an AI provider. Depending on where you and your customers are, that
may carry obligations — under GDPR or similar rules, a customer's message is
personal data, and you're responsible for what you do with it. That's a real
consideration, not a formality, and it's yours to make, not ours to make for you.
If your company has a policy about AI tools or customer data, follow it.

**Two practical habits:**

- Don't paste anything into a WhatsApp thread that you wouldn't want an AI
  provider to process. The extension only reads what's in the conversation.
- Look at where your provider is based and what their terms say about training
  on your data. Some offer a setting to opt out. Turn it on.

The full statement is in **[PRIVACY.md](PRIVACY.md)**.

**About your API key:** it's stored unencrypted in your Chrome profile, which is
normal for this kind of tool but does mean anyone with access to your computer
account can read it. Treat it like a password.

**Not affiliated with WhatsApp.** This is an independent tool. It isn't made by,
endorsed by, or connected to WhatsApp, Meta, or any AI provider. It works by
automating your own browser session, the same way you do by hand — which means it
can break if WhatsApp changes their page, and it's your responsibility to use it
in line with the terms that apply to you.

---

## 10. When something goes wrong

**The panel doesn't seem to notice the conversation I'm looking at.**
Click **Re-read** at the top of the panel. It normally follows along by itself.

**"Fill in API Base URL, API Key first."**
The setup isn't finished. Click the gear icon and complete it. Use **Test
Connection** — it tells you which of the three values is wrong rather than just
failing.

**"Authentication failed."**
The key is wrong, expired, or has no credit on the provider's side. Check your
provider's dashboard first — this is usually billing, not the key.

**"API endpoint invalid."**
The Base URL is wrong. It should look like `https://api.provider.com/v1` — with
the `/v1`, and without `/chat/completions` on the end.

**"The model doesn't exist."**
The Model ID has a typo, or your provider doesn't offer that model. Copy it again
from their model list, exactly.

**The reply comes back empty.**
Some models "think" before answering and spend the whole budget doing it. Open
the settings and set **Max output tokens** back to `0` (automatic), or set
**Thinking** to `Off`. This mostly happens with reasoning models.

**It worked, then stopped after I restarted Chrome.**
The folder you unzipped has probably been moved or deleted. Chrome loads the
extension from that folder every time it starts. Put it somewhere permanent, then
on `chrome://extensions` remove the extension and click **Load unpacked** again.

**A new version came out.**
Download the new ZIP, unzip it over the old folder, then click the reload arrow
on `chrome://extensions`. Your settings and API key are kept.

---

## 11. What it does not do

Being clear about this is more useful than a longer feature list.

- **It doesn't send anything by itself.** There's no automation, no scheduled
  sending, no auto-reply while you're away. Every message is a click.
- **It doesn't message people who haven't messaged you.** There's no bulk send,
  no contact import, no cold outreach. It only works inside conversations that
  already exist.
- **It doesn't read your chat list.** It sees the conversation you have open.
  It doesn't scan, doesn't archive, doesn't build a database of your contacts.
- **It doesn't scroll up to load old history.** It reads what WhatsApp has
  already loaded on screen. For a very long thread, that may be less than you'd
  like — scroll up in WhatsApp first.
- **It doesn't connect to your CRM.** No Salesforce, no HubSpot, no Pipedrive,
  no spreadsheets. Nothing is synced anywhere.
- **It doesn't handle images, voice notes or attachments.** Text only.
- **It doesn't know anything you haven't told it.** It has no memory of your
  business beyond the prompt you wrote. If it says something wrong about your
  pricing, that's a prompt problem — fix the prompt.

---

## 12. For Developers

Everything below this line is for people who want to read, modify or contribute
to the code. If you're a salesperson, you're done — go sell something.

**Stack:** Chrome Manifest V3 extension. Vanilla JavaScript, no build step,
no dependencies, no `package.json`. The AI call goes directly from the extension
to an OpenAI-compatible `/chat/completions` endpoint. There is no backend.

```
manifest.json
src/
  shared/      constants.js, utils.js (+ generated .classic.js copies)
  content/     WhatsApp Web DOM adapter, classic content script
  ai/          request building, endpoint resolution, fallback, connection test
  background/  service worker: message router, orchestration, send guard
  sidepanel/   the panel UI
  test/        development-only test bridge (not shipped)
tools/         Node.js development tooling (not shipped)
docs/          architecture, development, testing, getting started
```

**Docs:**

| | |
|---|---|
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | Install guide for non-technical users |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data flow, security design, DOM strategy |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, the classic-copy gotcha, the test bridge |
| [docs/TESTING.md](docs/TESTING.md) | How the project is verified, and its limits |
| [AGENTS.md](AGENTS.md) | **Read this before working in the repo** — CDP constraints, red lines, verification paths |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Bug reports, pull requests, conventions |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, and the honest security model |
| [PRIVACY.md](PRIVACY.md) | What leaves the machine and what doesn't |
| [docs/RELEASE_NOTES_v0.1.0.md](docs/RELEASE_NOTES_v0.1.0.md) | The text of the current GitHub Release |

**Quick start:**

```bash
# offline logic tests — no browser needed
node tools/test-safety.js

# after editing src/shared/*.js — regenerates the classic copies (see DEVELOPMENT.md)
node tools/build-classic.js
```

Two things bite people, both documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md):

1. `src/shared/constants.js` and `utils.js` are ES modules, but the content
   script is a classic script, so generated `.classic.js` copies exist. Edit the
   module without regenerating the copy and your change **silently disappears**
   at runtime.
2. Chrome 136+ restricts remote debugging and 154 blocks it outright on a default
   user-data-dir. The tooling here does not work around that by cloning your
   profile — do not do that either, it invalidates your WhatsApp login. Use the
   **test bridge** instead, which needs no debug port.

**Releasing:**

```bash
node tools/build-classic.js --check                            # copies must match
node tools/test-safety.js                                      # offline suite
node tools/build-release.js                                    # writes dist/
node tools/verify-release.js dist/whatsapp-sales-ai-copilot-0.1.0.zip
```

The last line is the one that matters: it installs the ZIP into a throwaway
Chrome for Testing profile and asks Chrome itself whether the extension loaded,
enabled and started its service worker. Reading the source cannot tell you that.

The ZIP contains `manifest.json` and `src/` minus `src/test/` — no `tools/`, no
development bridge, no screenshots, no git history. `.github/workflows/release.yml`
builds it on a version tag and attaches it to the Release.

---

## License

[MIT](LICENSE) © Employee Zero

Not affiliated with, endorsed by, or connected to WhatsApp, Meta, or any AI
provider. "WhatsApp" is a trademark of Meta Platforms, Inc.
