# Getting Started

Install **WhatsApp Sales AI Copilot** in four steps. No coding required.

**You'll need:** Google Chrome, WhatsApp Web, and **one** way to reach an AI:

- **ChatGPT Plus or Pro** (easiest) — needs a Mac with Apple silicon, because it uses the free **ChatGPT Connector** app. *Or*
- **an API key** from an AI provider — works on any computer, nothing extra to install.

## Step 1 — Download the Chrome extension

1. Open the **[latest release](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)**.
2. Under **Assets**, download the **`WhatsApp-Sales-AI-Copilot-Chrome-Extension-v….zip`** file. This is the main program and **everyone needs it first**.
3. Unzip it and keep the folder somewhere permanent, such as Documents.

Do **not** download the files labeled "Source code". **ChatGPT Connector** is a separate download, needed only for ChatGPT on a Mac. You do not get it from the release above: the extension's **Download for Mac** button links to it (it is published with [release v0.1.2](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.2) and works with later extension versions).

*You do not need a GitHub account to download.*

## Step 2 — Install in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.

<a href="assets/00-chrome-extensions.png"><img src="assets/00-chrome-extensions.png" alt="Chrome Extensions page in English: enable Developer mode, then click Load unpacked" width="780"></a>

You can pin the extension's icon to the Chrome toolbar for easy access.

## Step 3 — Connect your AI

Open [WhatsApp Web](https://web.whatsapp.com) and click the extension icon. Choose **ChatGPT** or **API Key**. You can switch later; each keeps its own settings.

### Option A — ChatGPT (easiest, for Plus or Pro on a Mac with Apple silicon)

Uses the ChatGPT plan you already pay for — **no API key needed**. In the extension choose **ChatGPT**; it shows three steps:

1. **Install ChatGPT Connector.** Click **Download for Mac** and open the downloaded `.pkg`. It is a small background app made by Employee Zero (not by OpenAI). It handles your ChatGPT sign-in on your own Mac. When it is running, the step shows **✓ Ready**; use **Recheck** if it does not update.
2. **Allow Local Access.** Click **Allow Access** and accept Chrome's prompt. This only lets the extension talk to the Connector on your own computer.
3. **Continue with ChatGPT.** A tab opens at OpenAI — sign in and accept the plan permissions. Back in the extension, pick a **Model** and click **Save & Continue**.

**If macOS says it can't open the installer.** The installer is not signed with an Apple Developer ID and is not notarized by Apple, so macOS may block the first double-click. That is expected. Only use the file from Employee Zero's GitHub Release, then:

1. Double-click the `.pkg`. When macOS says it can't be opened, click **Done**.
2. Open **System Settings → Privacy & Security** and scroll to the **Security** section.
3. Next to the installer's name, click **Open Anyway**, then confirm (password or Touch ID).
4. Open the installer again and follow it to the end.

You never need to turn off any macOS protection. The extension has the same three steps in a *macOS blocked the installer?* link beside the download button.

**Cost.** Replies use your ChatGPT plan's allowance, shared with ChatGPT itself — not unlimited. OpenAI decides at sign-in whether your plan can be used this way. A ChatGPT subscription is separate from API credit.

**Where your sign-in is kept.** On your own Mac, in a file only your user account can read — not in the browser. **Sign Out** in the extension revokes it at OpenAI and deletes it.

**Optional backup.** In **Settings → AI Connection → ChatGPT** you can turn on **Use API Key as backup**. It is **off by default**. When on, and only if ChatGPT is out of allowance or temporarily unavailable, the request goes to your API provider instead — **which means your chat text is sent to that third-party provider**. Fill in the API fields (Option B) for it to work.

### Option B — API Key

No Connector, no ChatGPT subscription. Works on any computer.

**What is an API key?** A private code that lets this extension use an AI provider. It is different from your ChatGPT login or subscription — your provider bills it separately.

If you don't have one: pick a provider with an **OpenAI-compatible API**, create an account, generate a key in its dashboard, and find its **API Base URL** and **Model ID** in its documentation.

In the extension choose **API Key** and fill in:

- **API Base URL** * — your provider's API address.
- **API Key** * — your private key.
- **Model ID** * — the model you want to use.
- **Fallback Base URL** — optional; leave empty unless you need it.

(* required). Click **Test Connection**, then **Save & Continue**.

**Cost.** The extension is free and open source; your provider charges you at its own rates. **Keep your API key private** — do not share it.

### Changing your mind later

Open Settings (the ⚙ button). **AI Connection** at the top switches between **ChatGPT** and **API Key**; the other one's details are kept. Settings is one page: AI Connection, AI Prompt, Messages, Conversation Context Character Limit, Thinking Depth (API Key), Advanced Settings (API Key), then **Save Settings**.

## Step 4 — Generate your first reply

1. Open a customer conversation in WhatsApp Web.
2. Click **Generate Reply** and wait for **✓ Ready** next to *AI Reply*.
3. Review or edit the message.
4. Click **Send**.

<a href="assets/04-generated-draft.png"><img src="assets/04-generated-draft.png" alt="AI-generated reply and draft (earlier build)" width="260"></a>

Choose **Short**, **Medium** or **Long**. Use **Add a tip for this message** for private guidance (for example, "Ask if their financing is approved") — the AI uses it but never repeats it to the customer. **Reload** re-reads the open conversation.

**Follow-up & Send** writes *and sends* a reply in one click, without showing it to you first. Use it deliberately.

## Need help?

**Can't find Load unpacked?** Turn on Developer mode first.

**Extension won't load?** Select the folder containing `manifest.json`, not the ZIP.

**Step 1 says "Not installed" after installing.** Click **Recheck**. If Step 2 is not allowed, click **Allow Access** first — the extension can't look for the Connector without it.

**macOS blocked the installer.** See *If macOS says it can't open the installer* above.

**"No plan access", or an allowance message.** That comes from OpenAI and can't be worked around here. Use **API Key**, or turn on the API Key backup.

**Sign-in finished but replies fail.** Click **Sign Out**, then **Continue with ChatGPT** again and accept the plan permissions.

**API Key connection failed.** Check API Base URL, API Key, Model ID and your provider account.

**Updating?** Download the latest `…Chrome-Extension-v….zip`, replace the files in the same folder, click Reload on `chrome://extensions`, and refresh WhatsApp Web. If a new ChatGPT Connector is offered, install it the same way; your sign-in is kept.

**Developers** can still run the Connector from source — see [helper/README.md](../helper/README.md).

For privacy details see [PRIVACY.md](../PRIVACY.md).

*When you generate a reply, your chat text is sent to the AI provider you selected.*

[← Back to project home](../README.md)
