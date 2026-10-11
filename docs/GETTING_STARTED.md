# Getting Started

Install **WhatsApp Sales AI Copilot** in four steps. No coding required.

**You'll need:** Google Chrome, WhatsApp Web, and an API key from an AI provider.

## Step 1 — Download

1. Open the **[latest release](https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/latest)**.
2. Under **Assets**, download the extension ZIP file. Do **not** download the files labeled "Source code".
3. Unzip the file and keep the extracted folder somewhere permanent, such as Documents.

*You do not need a GitHub account to download the extension.*

## Step 2 — Install in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.

<a href="assets/00-chrome-extensions.png"><img src="assets/00-chrome-extensions.png" alt="Chrome Extensions page in English: enable Developer mode, then click Load unpacked" width="780"></a>

The extension is now installed. You can pin its icon to the Chrome toolbar for easy access.

## Step 3 — Connect Your AI

The extension needs an AI service to generate replies.

**What is an API key?**

An API key is a private code that allows this extension to connect to an AI provider. It's different from your ChatGPT login or subscription.

If you don't have one yet:

1. Choose an AI provider that supports an **OpenAI-compatible API**.
2. Create an API account and generate a key from the provider's dashboard.
3. Find the provider's **API Base URL** and **Model ID** in its documentation.

Open [WhatsApp Web](https://web.whatsapp.com), then click the extension icon.

Enter:

- **API Base URL** — your provider's API address.
- **API Key** — your private API key.
- **Model ID** — the AI model you want to use.

Leave **Fallback Base URL** empty unless you need it. Click **Test Connection**, then **Save & Continue**.

<table>
<tr>
<td align="center"><a href="assets/01-first-run-setup.png"><img src="assets/01-first-run-setup.png" alt="Enter AI provider details" width="195"></a><br><sub>Enter details</sub></td>
<td align="center"><a href="assets/02-connect-your-ai.png"><img src="assets/02-connect-your-ai.png" alt="Test the AI connection" width="195"></a><br><sub>Test connection</sub></td>
<td align="center"><a href="assets/03-what-to-do-next.png"><img src="assets/03-what-to-do-next.png" alt="Complete setup" width="195"></a><br><sub>Continue</sub></td>
</tr>
</table>

**Cost:** The extension is free and open source. Your AI provider may charge for API usage. A ChatGPT subscription does **not** include API credits.

**Keep your API key private.** Do not share it with anyone.

## Step 4 — Generate Your First Reply

1. Open a customer conversation in WhatsApp Web.
2. Click **Generate Reply**.
3. Review or edit the AI-generated message.
4. Click **Send**.

<table>
<tr>
<td align="center"><a href="assets/04-generated-draft.png"><img src="assets/04-generated-draft.png" alt="AI-generated reply and draft" width="225"></a><br><sub>Generate and edit</sub></td>
<td align="center"><a href="assets/05-per-chat-instruction.png"><img src="assets/05-per-chat-instruction.png" alt="Optional customer-specific instruction" width="225"></a><br><sub>Optional chat instructions</sub></td>
</tr>
</table>

You can also choose Short, Medium, or Long replies and add instructions for individual customers.

## Need Help?

**Can't find Load unpacked?** Enable Developer mode first.

**Extension won't load?** Select the folder containing `manifest.json`, not the ZIP file.

**AI connection failed?** Check your API Base URL, API Key, Model ID, and provider account.

**Updating the extension?** Download the latest ZIP, replace the files in the same folder, and click Reload on `chrome://extensions`. Refresh WhatsApp Web afterward.

For privacy details, see [PRIVACY.md](../PRIVACY.md).

*Screenshots show fictional demo data. When you generate a reply, your chat text is sent to your selected AI provider.*

[← Back to project home](../README.md)
