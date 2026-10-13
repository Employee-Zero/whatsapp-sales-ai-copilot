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

### macOS installation: what to do if Apple blocks the Connector

The ChatGPT Connector is currently **not signed with an Apple Developer ID or notarized by Apple**, so your Mac may block the installer. This does not prove that the file is safe: **only continue if you downloaded it from the [official Employee Zero release](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.2)** and you trust the source. You **do not need to disable macOS security settings**.

**1 — Click Done on the first warning.** Double-click the downloaded `.pkg`. If macOS shows **“Not Opened”**, click **Done** (do not click *Move to Trash*).

![macOS warning that the Connector installer could not be verified (example from a user's report)](https://github.com/user-attachments/assets/4ad4ca8c-2215-4efa-92af-cea6a9bafd22)

**2 — Find Open Anyway.** Open **Apple menu  → System Settings → Privacy & Security**, scroll to **Security**, find the blocked installer message and click **Open Anyway**. If the button is missing, first try opening the same downloaded installer once more, then return to this screen.

**3 — Confirm Open Anyway.** In the new confirmation dialog, click **Open Anyway** again. Authenticate with your Mac password or Touch ID if prompted.

**4 — Finish installation.** Follow the installer windows until you see **“The installation was successful”**, then click **Close**. A notification that **ChatGPT Connector can run in the background** is normal.

**5 — Return to the Chrome extension.** Click **Recheck** if necessary. Confirm **Install ChatGPT Connector → ✓ Ready** and **Allow Local Access → ✓ Allowed**, then click **Continue with ChatGPT**. Sign in and authorize access, return to WhatsApp Web, choose a model and save. A **“You are signed in”** browser tab indicates authorization succeeded; you can close that tab.

> **Troubleshooting:** If the Connector still shows *Not installed* after installation, verify Chrome **Allow Local Access** is allowed, then click **Recheck**. A missing ✓ Ready indicates the local background service is not reachable, not necessarily that the package failed to install.
>
> **For image-by-image support**, see [Installation issue #3](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/issues/3). The extension also has a collapsible *macOS blocked the installer? How to open it* guide beneath **Download for Mac**.

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
