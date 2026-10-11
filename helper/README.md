# Local helper — ChatGPT subscription connection

This is the small program that lets WhatsApp Sales AI Copilot use your own
ChatGPT plan instead of an API key. It is part of this project, it runs on your
computer, and it is only needed if you choose **ChatGPT subscription** in the
extension's settings.

**If you use the "Your own API key" method, you do not need this and can ignore
this folder entirely.** That method works on its own, with nothing installed.

---

## Why it exists

It is not an implementation preference. OpenAI's sign-in for open-source and
locally hosted apps accepts **only** a callback to an HTTP listener on
`127.0.0.1`. A browser extension cannot open a listening socket, and the only
redirect a Chrome extension *can* intercept (`chromiumapp.org`) is not an
address that sign-in accepts. So the sign-in has to be completed by a process on
the same machine, and that process is this one.

There is a second reason, and it is the more important one: **your sign-in stays
out of the browser.** OpenAI's documentation for this flow says to keep tokens
out of browser storage, source control and logs. Rather than try to be careful,
the extension is simply never given a token — it holds no field that could store
one. The credential lives in a file this helper owns, and the browser only ever
talks to `127.0.0.1`.

## What you need

- **Node.js 20 or later.** Check with `node --version`.
- Nothing else. There are no dependencies to install and no build step.

## Running it

From the folder that contains this `helper` directory:

```
node helper/siwc-helper.js
```

Leave it running while you use the subscription method. Then, in the extension's
settings, click **Continue with ChatGPT** — a normal browser tab opens at
openai.com, you sign in there, and the extension notices on its own.

The first sign-in registers this installation with OpenAI and takes slightly
longer than later ones.

### Options

```
node helper/siwc-helper.js [options]

  --port <n>              Port to listen on (default 8788). Must match the
                          Helper address in the extension's settings.
  --status                Print the current connection state as JSON and exit.
  --print-authorize-url   Start a sign-in and print the URL instead of opening
                          a tab. For machines with no browser.
  --sign-out              Sign out and revoke the credential, then exit.
  --help                  Show this message.
```

## What it stores, and where

One file:

| Platform | Location |
|---|---|
| macOS / Linux | `~/.config/whatsapp-sales-ai-copilot/credentials.json` |
| Windows | `%APPDATA%\whatsapp-sales-ai-copilot\credentials.json` |

It holds the access token, the refresh token, the ID token, the client ID OpenAI
issued to this installation, and the account's email as a label. The directory is
created `0700` and the file `0600`, so only your user account can read it. Writes
are atomic, so an interrupted write cannot leave a half-written file behind. On
Windows, POSIX file modes do not apply and the file inherits the permissions of
your user profile directory — `--status` reports which of the two happened.

Signing out from the extension revokes the credential at OpenAI and deletes the
file. The access token expires after an hour on its own; the refresh token lasts
30 days and is renewed automatically while the helper runs.

## What it will not do

- It never sends anything to WhatsApp, and it has no way to.
- It never reads your browser's cookies or your ChatGPT session.
- It does not log a token, and it does not print one. Logs show the account's
  email label and nothing else.
- It listens on `127.0.0.1` only — never on your local network — and refuses
  requests whose `Host` header is not the loopback address itself, requests from
  a web page's origin, and non-JSON request bodies.
- It does not use ChatGPT's internal endpoints. Inference goes to the public
  Responses API at `api.openai.com`, with `store: false`, so responses are not
  retained for training.

## If something goes wrong

**"The local helper is not running"** — the process is not started, or it is on a
different port from the one in the extension's settings. Start it and check that
the port matches.

**"Port 8788 is already in use"** — another copy is probably already running.
That is usually fine; if not, start it with `--port 8789` and put
`http://127.0.0.1:8789` in the extension's Helper address field.

**Sign-in completes but replies still fail** — the sign-in may not have included
permission to use your plan. `node helper/siwc-helper.js --status` shows whether
plan usage is allowed. If it is not, sign out and sign in again, accepting the
plan permissions when asked.

**Your account is not eligible, or has no allowance left** — these come from
OpenAI, not from this program, and it cannot work around either. The extension
says which one it was. Switching to your own API key always works.

## Endpoints

The extension talks to these on `http://127.0.0.1:<port>`. All of them return
JSON.

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Is it up, and what version |
| GET | `/auth/status` | Signed in, plan permission, credential file |
| POST | `/auth/start` | Begin a sign-in; returns the URL to open |
| GET | `/auth/callback` | Where OpenAI sends you back to |
| POST | `/auth/sign-out` | Revoke and forget |
| GET | `/models` | The models this account may use |
| POST | `/generate` | One reply, streamed |
| POST | `/test` | One short labelled request |

## Licence

Same as the project it ships with. See the repository root.
