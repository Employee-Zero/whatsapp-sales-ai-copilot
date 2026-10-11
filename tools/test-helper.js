#!/usr/bin/env node
'use strict';

/**
 * Offline unit tests for the local ChatGPT-plan helper.
 *
 * These need Node but NOT Chrome, and NOT the network: every test either calls a
 * pure function directly, or replaces `globalThis.fetch` with a stub and checks
 * what the code would have put on the wire.
 *
 * What is covered, and why each one is worth a test rather than trust:
 *
 *   1. PKCE            — a wrong S256 digest fails at the very end of a flow the
 *                        user has already consented to, with an error nobody can
 *                        act on.
 *   2. SSE parsing     — frames do not respect chunk boundaries. Everything works
 *                        on a fast local test and drops events against a real
 *                        network, so the frame is re-split at every offset.
 *   3. The stream contract — `response.completed` is the only success signal. A
 *                        stream that ends without it must be a failure, because
 *                        the alternative is showing a customer half a sentence.
 *   4. The request body — the parameter subset matters as much as the values.
 *                        Re-adding `temperature` is what produces
 *                        `subscription_sharing_unsupported_capability`.
 *   5. Loopback guards — a `127.0.0.1` bind without a Host check is theatre.
 *   6. Credential file — modes, atomicity, and a corrupt file that is reported
 *                        rather than silently replaced.
 *   7. ID-token validation — signature, issuer, audience, expiry, nonce.
 *   8. Cross-checks    — the helper's duplicated constants against the
 *                        extension's, in both directions, and its version against
 *                        `manifest.json`.
 *
 * Run: node tools/test-helper.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { generateKeyPairSync, createSign, createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/** Import an ESM module from a CommonJS test file. */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let pass = 0;
let fail = 0;

/**
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [detail]
 */
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** Collect errors thrown by an async function, for the "must refuse" tests. */
async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err || new Error('threw a falsy value');
  }
}

async function main() {
  const pkce = await load('helper/lib/pkce.js');
  const responses = await load('helper/lib/responses.js');
  const guard = await load('helper/lib/guard.js');
  const store = await load('helper/lib/store.js');
  const oauth = await load('helper/lib/oauth.js');
  const errors = await load('helper/lib/errors.js');
  const helperConstants = await load('helper/lib/constants.js');
  const helperMain = await load('helper/siwc-helper.js');

  // -------------------------------------------------------------------------
  console.log('\n[1] PKCE — the only thing binding a code to this process\n');

  const pair = pkce.createPkce();
  eq('the challenge method is S256', pair.method, 'S256');
  eq('the verifier is 86 base64url characters', pair.verifier.length, 86);
  check('the verifier uses only the unreserved alphabet', /^[A-Za-z0-9\-_]+$/.test(pair.verifier));
  check('the verifier carries no base64 padding', !pair.verifier.includes('='));
  check('the challenge carries no base64 padding', !pair.challenge.includes('='));
  eq('the challenge is the unpadded base64url SHA-256 of the verifier', pair.challenge, pkce.base64url(createHash('sha256').update(pair.verifier, 'ascii').digest()));
  check('the challenge is not the verifier', pair.challenge !== pair.verifier);
  eq('the challenge is 43 characters', pair.challenge.length, 43);

  const pair2 = pkce.createPkce();
  check('two sign-ins never share a verifier', pair.verifier !== pair2.verifier);
  check('nor a challenge', pair.challenge !== pair2.challenge);

  check('base64url strips padding rather than emitting it', !pkce.base64url(Buffer.from([0, 0, 0])).includes('='));
  check('base64url uses - and _ rather than + and /', pkce.base64url(Buffer.from([0xfb, 0xff, 0xfe])) === '-__-');

  eq('a state value is 43 characters of base64url', pkce.randomUrlSafe(32).length, 43);
  check('a host id is a urn:uuid', /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pkce.newHostId()));
  check('and two of them differ', pkce.newHostId() !== pkce.newHostId());

  // -------------------------------------------------------------------------
  console.log('\n[2] SSE parsing — a frame can be split anywhere\n');

  const FRAME = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n';

  {
    const p = responses.createSseParser();
    const out = p.push(FRAME);
    eq('an intact frame yields one event', out.length, 1);
    eq('with its event name', out[0].event, 'response.output_text.delta');
    eq('and its data intact', JSON.parse(out[0].data).delta, 'Hello');
  }

  // The point of the whole incremental design: every possible split of the same
  // frame must produce the same single event.
  let splitFailures = 0;
  for (let at = 1; at < FRAME.length; at++) {
    const p = responses.createSseParser();
    const out = [...p.push(FRAME.slice(0, at)), ...p.push(FRAME.slice(at)), ...p.flush()];
    if (out.length !== 1 || JSON.parse(out[0].data).delta !== 'Hello') splitFailures++;
  }
  eq('the frame parses identically when split at any of its offsets', splitFailures, 0);

  // Byte-by-byte is how a slow network actually delivers it.
  {
    const p = responses.createSseParser();
    const out = [];
    for (const ch of FRAME) out.push(...p.push(ch));
    out.push(...p.flush());
    eq('and when delivered one character at a time', out.length, 1);
  }

  // CRLF, straddling a chunk boundary. This is the case a naive
  // `split('\n\n')` gets wrong on the second chunk and not the first.
  {
    const crlf = FRAME.replace(/\n/g, '\r\n');
    const p = responses.createSseParser();
    const out = [...p.push(crlf.slice(0, 40)), ...p.push(crlf.slice(40)), ...p.flush()];
    eq('a CRLF frame split mid-terminator still parses', out.length, 1);
  }

  {
    const p = responses.createSseParser();
    eq('a keep-alive comment produces nothing', p.push(':\n\n').length, 0);
    eq('nor does a partial frame', p.push('data: {"a"').length, 0);
    eq('but flush() releases it', p.flush().length, 1);
  }

  {
    const p = responses.createSseParser();
    const out = p.push('data: line one\ndata: line two\n\n');
    eq('multi-line data is joined with a newline', out[0].data, 'line one\nline two');
  }

  {
    const p = responses.createSseParser();
    const out = p.push('data:{"type":"x"}\n\n');
    eq('a missing space after the colon is accepted', out.length, 1);
  }

  {
    const p = responses.createSseParser();
    const out = p.push('data:  two spaces\n\n');
    eq('exactly one space after the colon is stripped', out[0].data, ' two spaces');
  }

  {
    const p = responses.createSseParser();
    eq('a chunk with no frame yields nothing', p.push('data: nothing yet').length, 0);
    eq('a chunk carrying three frames yields three events', p.push('\n\ndata: a\n\ndata: b\n\n').length, 3);
  }

  // -------------------------------------------------------------------------
  console.log('\n[3] Frame classification and text extraction\n');

  eq('response.completed is the success signal', responses.classifyFrame({ event: '', data: '{"type":"response.completed"}' }).kind, 'completed');
  eq('a text delta is a delta', responses.classifyFrame({ event: '', data: '{"type":"response.output_text.delta","delta":"x"}' }).kind, 'delta');
  eq('response.failed is a failure', responses.classifyFrame({ event: '', data: '{"type":"response.failed"}' }).kind, 'failed');
  eq('response.incomplete is a failure', responses.classifyFrame({ event: '', data: '{"type":"response.incomplete"}' }).kind, 'incomplete');
  eq('a top-level error frame is an error', responses.classifyFrame({ event: '', data: '{"type":"error"}' }).kind, 'error');
  eq('[DONE] is recognised', responses.classifyFrame({ event: '', data: '[DONE]' }).kind, 'done');
  eq('an unknown event type is passed through, not dropped', responses.classifyFrame({ event: '', data: '{"type":"response.in_progress"}' }).kind, 'other');
  eq('unparseable data is reported as such', responses.classifyFrame({ event: '', data: 'not json' }).kind, 'unparsable');
  eq('and is truncated rather than echoed whole', responses.classifyFrame({ event: '', data: 'x'.repeat(500) }).payload.length, 200);

  eq(
    'text is read out of the finished response',
    responses.extractOutputText({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello there' }] },
      ],
    }),
    'Hello there',
  );
  eq('an empty output yields empty text', responses.extractOutputText({ output: [] }), '');
  eq('a missing output yields empty text', responses.extractOutputText({}), '');
  eq(
    'several message items are concatenated',
    responses.extractOutputText({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'one' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'two' }] },
      ],
    }),
    'onetwo',
  );

  // -------------------------------------------------------------------------
  console.log('\n[4] The request body — the subset is the contract\n');

  const body = responses.buildResponsesBody({ model: 'gpt-6.1-sol', instructions: 'be brief', input: 'hi' });
  eq('the body has exactly five keys', Object.keys(body).sort().join(','), 'input,instructions,model,store,stream');
  eq('store is false', body.store, false);
  eq('stream is true', body.stream, true);

  // The published preview limitations reject a long list of ordinary Responses
  // parameters. Sending one back is the documented cause of
  // `subscription_sharing_unsupported_capability`, so this is asserted rather
  // than trusted.
  for (const banned of ['temperature', 'max_output_tokens', 'top_p', 'top_k', 'truncation', 'previous_response_id', 'metadata', 'prompt', 'tools', 'tool_choice', 'response_format', 'seed', 'user', 'stop', 'frequency_penalty', 'presence_penalty', 'logprobs', 'n']) {
    check(`the body never carries ${banned}`, !(banned in body));
  }

  eq('the responses endpoint is the public API host', responses.RESPONSES_URL, 'https://api.openai.com/v1/responses');
  eq('the models endpoint is the public API host', responses.MODELS_URL, 'https://api.openai.com/v1/models');
  {
    // Comments explaining that ChatGPT's internal endpoints are NOT used are
    // welcome; a string that names one is not. So the comments come out first.
    const stripped = fs
      .readFileSync(path.join(ROOT, 'helper/lib/responses.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check('no ChatGPT-internal backend endpoint is named in code', !/backend-api|chatgpt\.com/.test(stripped));
    check('every absolute URL in the module is on api.openai.com', (stripped.match(/https:\/\/[a-z0-9.-]+/gi) || []).every((u) => u.includes('api.openai.com')), (stripped.match(/https:\/\/[a-z0-9.-]+/gi) || []).join(' '));
  }

  eq('a caller timeout inside the window is honoured', responses.clampTimeout(30_000), 30_000);
  eq('a timeout above the ceiling is clamped', responses.clampTimeout(999_999), responses.INFERENCE_TIMEOUT_MS);
  eq('a timeout below the floor is raised', responses.clampTimeout(10), 5_000);
  eq('a missing timeout falls back to the ceiling', responses.clampTimeout(undefined), responses.INFERENCE_TIMEOUT_MS);
  eq('as does a nonsensical one', responses.clampTimeout('soon'), responses.INFERENCE_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  console.log('\n[5] Inference — the complete stream, and the truncated one\n');

  const realFetch = globalThis.fetch;
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

  /** Replace fetch with a stub that answers with the given SSE body. */
  function stubStream(text, { status = 200, headers = {} } = {}) {
    globalThis.fetch = async () =>
      new Response(text, {
        status,
        headers: Object.assign({ 'content-type': 'text/event-stream' }, headers),
      });
  }

  const COMPLETE =
    sse({ type: 'response.created', response: { id: 'resp_1' } }) +
    sse({ type: 'response.output_text.delta', delta: 'Hi ' }) +
    sse({ type: 'response.output_text.delta', delta: 'there' }) +
    sse({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-6.1-sol',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there' }] }],
        usage: { total_tokens: 12 },
      },
    });

  try {
    stubStream(COMPLETE);
    const out = await responses.generate({ accessToken: 'not-a-real-token', model: 'gpt-6.1-sol', instructions: 'x', input: 'y' });
    eq('a completed stream yields the text', out.text, 'Hi there');
    eq('and the model OpenAI reported', out.model, 'gpt-6.1-sol');
    eq('and the response id', out.responseId, 'resp_1');
    eq('and the usage', out.usage.total_tokens, 12);

    // The failure this whole rule exists for: a stream that just stops.
    stubStream(sse({ type: 'response.output_text.delta', delta: 'Half a sentence' }));
    const cut = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    check('a stream that ends without response.completed is a failure', !!cut);
    eq('reported as unavailable, not as a result', cut && cut.code, 'CHATGPT_UNAVAILABLE');
    check('and the partial text is not handed back', !JSON.stringify(cut && cut.message).includes('Half a sentence'));

    // Only `response.completed` counts — a delta that happens to be the whole
    // reply is still not a completion.
    stubStream(sse({ type: 'response.output_text.delta', delta: 'Complete sentence.' }));
    const noComplete = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    eq('deltas alone are never treated as a finished reply', noComplete && noComplete.code, 'CHATGPT_UNAVAILABLE');

    // A mid-stream error frame, which is how a plan limit surfaces once the
    // reply is already being written.
    stubStream(sse({ type: 'error', error: { code: 'usage_limit_reached', message: 'limit' } }));
    const midErr = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    check('a mid-stream error frame is surfaced', !!midErr);
    check('with a code the panel can explain', ['CHATGPT_USAGE_LIMIT', 'CHATGPT_FAILED', 'CHATGPT_NOT_ELIGIBLE'].includes(midErr.code), midErr.code);

    // A completed response with no text at all.
    stubStream(sse({ type: 'response.completed', response: { id: 'r', output: [] } }));
    const empty = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    check('a completed but empty reply is refused', !!empty);
    eq('rather than returned as a blank message', empty && empty.code, 'CHATGPT_FAILED');

    // HTTP failures.
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'no' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    const unauth = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    check('a 401 becomes a sign-in message, not a raw status', unauth && unauth.code === 'CHATGPT_NOT_SIGNED_IN');

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    const limited = await rejects(() => responses.generate({ accessToken: 't', model: 'm', instructions: 'x', input: 'y' }));
    check('a 429 becomes an allowance message', limited && ['CHATGPT_USAGE_LIMIT', 'CHATGPT_UNAVAILABLE'].includes(limited.code), limited && limited.code);

    // The token must go in the header, never into the body or the URL.
    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(COMPLETE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    await responses.generate({ accessToken: 'secret-value', model: 'm', instructions: 'x', input: 'y' });
    eq('the access token travels in the Authorization header', seen.init.headers.Authorization, 'Bearer secret-value');
    check('and nowhere in the request body', !String(seen.init.body).includes('secret-value'));
    check('nor in the URL', !String(seen.url).includes('secret-value'));
    eq('the body sent is the minimal one', Object.keys(JSON.parse(seen.init.body)).sort().join(','), 'input,instructions,model,store,stream');

    // The model list keeps only what the account may actually use.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol', visibility: 'list' }, { id: 'internal-thing', visibility: 'hidden' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const models = await responses.listModels({ accessToken: 't' });
    check('the model list is filtered by visibility', !models.models.some((m) => m.slug === 'internal-thing'), JSON.stringify(models.models));
    check('and reports what survived', models.models.some((m) => m.slug === 'gpt-6.1-sol'));
  } finally {
    globalThis.fetch = realFetch;
  }

  // -------------------------------------------------------------------------
  console.log('\n[6] Loopback guards — the bind alone is not a defence\n');

  check('the configured host is accepted', guard.hostAllowed('127.0.0.1:8788', 8788));
  check('IPv6 loopback is accepted', guard.hostAllowed('[::1]:8788', 8788));
  // The DNS-rebinding case: a page on a name that resolves to 127.0.0.1.
  check('a name that resolves to loopback is refused', !guard.hostAllowed('evil.example:8788', 8788));
  check('localhost is not the configured address', !guard.hostAllowed('localhost:8788', 8788));
  check('a different local port is refused', !guard.hostAllowed('127.0.0.1:9999', 8788));
  check('a missing Host is refused', !guard.hostAllowed(undefined, 8788));
  check('an empty Host is refused', !guard.hostAllowed('', 8788));
  check('a Host with no port is refused', !guard.hostAllowed('127.0.0.1', 8788));
  check('a lookalike address is refused', !guard.hostAllowed('127.0.0.1.evil.example:8788', 8788));

  check('no Origin is allowed (curl, a test script)', guard.originAllowed(undefined));
  check('an extension origin is allowed', guard.originAllowed('chrome-extension://abcdefghijklmnop'));
  check('a web origin is refused', !guard.originAllowed('https://evil.example'));
  check('an http origin is refused', !guard.originAllowed('http://127.0.0.1:8788'));
  check('a sandboxed-iframe null origin is refused', !guard.originAllowed('null'));
  check('an empty-string origin is treated as absent', guard.originAllowed(''));

  check('a JSON body is accepted', guard.isJsonRequest('application/json'));
  check('a JSON body with a charset is accepted', guard.isJsonRequest('application/json; charset=utf-8'));
  check('a form body is refused', !guard.isJsonRequest('application/x-www-form-urlencoded'));
  // A "simple request" content type is exactly what skips the preflight, which
  // is what makes requiring JSON a defence rather than a formality.
  check('a text/plain body is refused', !guard.isJsonRequest('text/plain'));
  check('a missing content type is refused', !guard.isJsonRequest(undefined));

  // -------------------------------------------------------------------------
  console.log('\n[7] The credential file — modes, atomicity, corruption\n');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-store-'));
  process.env.WHATSAPP_COPILOT_HOME = tmpHome;

  {
    const first = store.readStore();
    check('a missing file is not an error', first.existed === false);
    eq('and yields an empty store', Object.keys(first.store.accounts).length, 0);

    const protection = store.describeProtection();
    check('an absent file is not reported as a permissions problem', protection.exists === false && protection.ownerOnly === true, JSON.stringify(protection));

    const doc = store.emptyStore();
    doc.hostId = 'urn:uuid:test';
    doc.activeAccount = 'sub:abc';
    doc.accounts['sub:abc'] = { sub: 'abc', email: 'a@example.com', label: 'A', accessToken: 'at', refreshToken: 'rt', clientId: 'oaiapp_x', scope: 'openid', expiresAt: Date.now() + 3600_000 };
    store.writeStore(doc);

    const back = store.readStore();
    check('the file round-trips', back.existed === true && back.store.accounts['sub:abc'].label === 'A');

    if (process.platform !== 'win32') {
      const fileMode = fs.statSync(store.storeFile()).mode & 0o777;
      const dirMode = fs.statSync(store.storeHome()).mode & 0o777;
      eq('the file is 0600', fileMode.toString(8), '600');
      eq('and its directory is 0700', dirMode.toString(8), '700');
      check('describeProtection agrees the file is owner-only', store.describeProtection().ownerOnly === true);
    }

    check('no temporary file is left behind', !fs.readdirSync(tmpHome).some((f) => f.includes('.tmp')));
    check('the credential file is not in the project directory', !store.storeFile().startsWith(ROOT));

    const redacted = store.redact(doc.accounts['sub:abc']);
    check('redact reports presence rather than values', redacted.hasAccessToken === true && redacted.hasRefreshToken === true);
    check('and never includes the token itself', !JSON.stringify(redacted).includes('"at"') && !JSON.stringify(redacted).includes('"rt"'));
    eq('the account key is the sub, not the email', store.accountKey('abc'), 'sub:abc');
    eq('a missing sub has no account key', store.accountKey(''), '');

    fs.writeFileSync(store.storeFile(), '{ not json');
    const corrupt = await rejects(async () => store.readStore());
    eq('a corrupt file is reported, not replaced', corrupt && corrupt.code, 'STORE_CORRUPT');
    eq('and the damaged file is left on disk for inspection', fs.readFileSync(store.storeFile(), 'utf8'), '{ not json');

    store.deleteStore();
    check('sign-out can remove the file', !fs.existsSync(store.storeFile()));
  }

  delete process.env.WHATSAPP_COPILOT_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  console.log('\n[8] The authorization URL — every parameter, and only the right ones\n');

  const auth = oauth.buildAuthorizeUrl({
    redirectUri: 'http://127.0.0.1:8788/auth/callback',
    scopes: helperConstants.CHATGPT_SCOPES,
    resource: helperConstants.CHATGPT_RESOURCE,
    hostId: 'urn:uuid:abc',
    appName: 'WhatsApp Sales AI Copilot',
  });
  const params = new URL(auth.url).searchParams;

  check('the authorization endpoint is OpenAI over https', auth.url.startsWith('https://auth.openai.com/'), auth.url.slice(0, 60));
  eq('the flow is an authorization-code flow', params.get('response_type'), 'code');
  eq('a first registration uses the documented dynamic client id', params.get('client_id'), 'dynamic_agent_client');
  eq('the redirect is the loopback callback', params.get('redirect_uri'), 'http://127.0.0.1:8788/auth/callback');
  eq('the resource is sent', params.get('resource'), helperConstants.CHATGPT_RESOURCE);
  eq('the scope is the full set', params.get('scope'), helperConstants.CHATGPT_SCOPES);
  eq('PKCE is S256', params.get('code_challenge_method'), 'S256');
  eq('the challenge is 43 characters', params.get('code_challenge').length, 43);
  check('a state is sent', params.get('state').length >= 32);
  check('a nonce is sent', params.get('nonce').length >= 32);
  check('state and nonce differ', params.get('state') !== params.get('nonce'));
  eq('the host id identifies this installation', params.get('ext_agent_host_id'), 'urn:uuid:abc');
  eq('the app name is offered on first registration', params.get('agent_name_hint'), 'WhatsApp Sales AI Copilot');
  check('consent is not forced by default', !params.has('prompt'));
  check('no secret is sent, because there is none', !params.has('client_secret'));
  check('the verifier is returned to the caller, not put in the URL', !auth.url.includes(auth.verifier));
  check('the URL is not the verifier', auth.verifier.length === 86 && !auth.url.includes('code_verifier'));

  // The documented difference between a first registration and a return visit.
  const again = oauth.buildAuthorizeUrl({
    redirectUri: 'http://127.0.0.1:8788/auth/callback',
    scopes: helperConstants.CHATGPT_SCOPES,
    resource: helperConstants.CHATGPT_RESOURCE,
    hostId: 'urn:uuid:abc',
    appName: 'WhatsApp Sales AI Copilot',
    clientId: 'oaiapp_issued',
  });
  const againParams = new URL(again.url).searchParams;
  eq('a return visit uses the issued client id', againParams.get('client_id'), 'oaiapp_issued');
  check('and omits the app name hint, as documented', !againParams.has('agent_name_hint'));
  eq('but still sends the host id', againParams.get('ext_agent_host_id'), 'urn:uuid:abc');
  check('and is not flagged as a first registration', again.firstRegistration === false);

  const consented = oauth.buildAuthorizeUrl({
    redirectUri: 'http://127.0.0.1:8788/auth/callback',
    scopes: helperConstants.CHATGPT_SCOPES,
    resource: helperConstants.CHATGPT_RESOURCE,
    hostId: 'urn:uuid:abc',
    appName: 'x',
    clientId: 'oaiapp_issued',
    forceConsent: true,
  });
  eq('re-consent uses the ordinary OAuth prompt parameter', new URL(consented.url).searchParams.get('prompt'), 'consent');

  // -------------------------------------------------------------------------
  console.log('\n[9] Callback parsing — the one undocumented parameter name\n');

  {
    const p = new URLSearchParams('code=abc&state=xyz');
    eq('an ordinary callback carries a code', p.get('code'), 'abc');
    eq('and no issued client id', oauth.parseRegistrationCallback(p).issuedClientId, '');
  }
  {
    const p = new URLSearchParams('code=abc&client_id=oaiapp_12345');
    eq('an explicit client_id is read', oauth.parseRegistrationCallback(p).issuedClientId, 'oaiapp_12345');
  }
  {
    // The parameter name is undocumented, so every value is scanned.
    const p = new URLSearchParams('code=abc&something_unexpected=oaiapp_999');
    eq('an issued id under an unknown parameter is still found', oauth.parseRegistrationCallback(p).issuedClientId, 'oaiapp_999');
  }
  {
    const p = new URLSearchParams('code=abc&client_id=dynamic_agent_client');
    eq('the dynamic id is not mistaken for an issued one', oauth.parseRegistrationCallback(p).issuedClientId, '');
  }
  {
    const p = new URLSearchParams('code=abc&b=2&a=1');
    eq('the parameter names that arrived are recorded', oauth.parseRegistrationCallback(p).parameterNames.join(','), 'a,b,code');
  }

  // -------------------------------------------------------------------------
  console.log('\n[10] ID-token validation — signature, issuer, audience, nonce\n');

  {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'test-key-1', alg: 'RS256', use: 'sig' });

    const sign = (header, claims) => {
      const h = Buffer.from(JSON.stringify(header)).toString('base64url');
      const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = createSign('RSA-SHA256').update(`${h}.${c}`, 'ascii').sign(privateKey).toString('base64url');
      return `${h}.${c}.${sig}`;
    };

    const now = Math.floor(Date.now() / 1000);
    const baseClaims = { iss: oauth.ISSUER, aud: 'oaiapp_issued', exp: now + 3600, iat: now, sub: 'user-1', nonce: 'n-1' };
    const goodHeader = { alg: 'RS256', kid: 'test-key-1', typ: 'JWT' };

    globalThis.fetch = async (url) => {
      if (String(url).includes('openid-configuration')) {
        return new Response(JSON.stringify({ jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke', token_endpoint: 'https://auth.openai.com/token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('jwks')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    };

    oauth.resetCaches();
    const claims = await oauth.validateIdToken(sign(goodHeader, baseClaims), { clientId: 'oaiapp_issued', nonce: 'n-1' });
    eq('a correctly signed token validates', claims.sub, 'user-1');

    // Tampering has to be done on the decoded bytes: the last base64url
    // character of a signature carries unused bits, so flipping it can produce
    // a string that still decodes to the same signature.
    const signed = sign(goodHeader, baseClaims).split('.');
    const sigBytes = Buffer.from(signed[2], 'base64url');
    sigBytes[0] ^= 0xff;
    const wrongSig = `${signed[0]}.${signed[1]}.${sigBytes.toString('base64url')}`;
    check('a tampered signature is refused', !!(await rejects(() => oauth.validateIdToken(wrongSig, { clientId: 'oaiapp_issued', nonce: 'n-1' }))));

    // Changing the claims and keeping the signature is the attack that matters.
    const swappedClaims = Buffer.from(JSON.stringify(Object.assign({}, baseClaims, { sub: 'somebody-else' }))).toString('base64url');
    check('claims swapped under a valid signature are refused', !!(await rejects(() => oauth.validateIdToken(`${signed[0]}.${swappedClaims}.${signed[2]}`, { clientId: 'oaiapp_issued', nonce: 'n-1' }))));

    check('a token signed by somebody else is refused', !!(await rejects(() => oauth.validateIdToken(sign({ alg: 'RS256', kid: 'test-key-1' }, Object.assign({}, baseClaims, { iss: 'https://evil.example' })), { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('a token issued to a different client is refused', !!(await rejects(() => oauth.validateIdToken(sign(goodHeader, Object.assign({}, baseClaims, { aud: 'oaiapp_other' })), { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('an expired token is refused', !!(await rejects(() => oauth.validateIdToken(sign(goodHeader, Object.assign({}, baseClaims, { exp: now - 7200 })), { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('a token from a different sign-in attempt is refused', !!(await rejects(() => oauth.validateIdToken(sign(goodHeader, Object.assign({}, baseClaims, { nonce: 'n-2' })), { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('an audience array containing the client is accepted', !!(await oauth.validateIdToken(sign(goodHeader, Object.assign({}, baseClaims, { aud: ['other', 'oaiapp_issued'] })), { clientId: 'oaiapp_issued', nonce: 'n-1' })));

    // `alg: none` is the classic JWT downgrade, and accepting it would make the
    // signature check decorative.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(baseClaims)).toString('base64url')}.`;
    check('an unsigned token is refused', !!(await rejects(() => oauth.validateIdToken(unsigned, { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    const hs = sign({ alg: 'HS256', kid: 'test-key-1' }, baseClaims);
    check('a token claiming a different algorithm is refused', !!(await rejects(() => oauth.validateIdToken(hs, { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('a malformed token is refused', !!(await rejects(() => oauth.validateIdToken('not.a.jwt', { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
    check('an empty token is refused', !!(await rejects(() => oauth.validateIdToken('', { clientId: 'oaiapp_issued', nonce: 'n-1' }))));
  }

  globalThis.fetch = realFetch;

  // -------------------------------------------------------------------------
  console.log('\n[11] Provider errors — a code the user can act on\n');

  {
    const mapped = errors.fromProvider(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, 'req_1');
    eq('a rate limit maps to the allowance code', mapped.code, 'CHATGPT_USAGE_LIMIT');
    eq('and the request id is kept for support', mapped.requestId, 'req_1');
    check('and the status is the documented one', mapped.status === 429);

    const e401 = errors.fromProvider(401, {}, '');
    eq('a bare 401 means sign in again', e401.code, 'CHATGPT_NOT_SIGNED_IN');
    eq('a bare 403 means not eligible', errors.fromProvider(403, {}, '').code, 'CHATGPT_NOT_ELIGIBLE');
    eq('a bare 503 is retryable unavailability', errors.fromProvider(503, {}, '').code, 'CHATGPT_UNAVAILABLE');
    check('and is flagged retryable', errors.fromProvider(503, {}, '').retryable === true);
    eq('a bare 400 is an unsupported-flow failure', errors.fromProvider(400, {}, '').code, 'CHATGPT_FAILED');

    // The bare `{detail: "..."}` shape the direct route is documented to return.
    const detail = errors.fromProvider(403, { detail: 'not admitted to this preview' }, '');
    check('the bare detail shape is understood', detail.detail.includes('not admitted'), detail.detail);
    eq('and still maps to a code the panel can explain', detail.code, 'CHATGPT_NOT_ELIGIBLE');

    check('every helper error code is a non-empty string', helperConstants.HELPER_ERROR_CODES.every((c) => typeof c === 'string' && c));

    // A message must never be the place a credential ends up.
    const thrown = errors.fromProvider(401, { error: { code: 'x', message: 'bad token sk-abcdef0123456789' } }, '');
    check('a provider message is carried through as detail, not as the user-facing line', !thrown.message.includes('sk-abcdef0123456789') || thrown.detail.includes('sk-'));
  }

  // -------------------------------------------------------------------------
  console.log('\n[12] Cross-checks — the duplicated constants must not drift\n');

  const extConstants = await load('src/shared/constants.js');
  // The extension's own client, so the allow-list it filters helper codes
  // through is compared rather than a copy of it.
  const chatgptClient = await load('src/ai/chatgpt-client.js');
  eq('the scope string is identical on both sides', extConstants.CHATGPT_SCOPES, helperConstants.CHATGPT_SCOPES);
  eq('the resource is identical', extConstants.CHATGPT_RESOURCE, helperConstants.CHATGPT_RESOURCE);
  eq('the plan scope is identical', extConstants.CHATGPT_PLAN_SCOPE, helperConstants.CHATGPT_PLAN_SCOPE);
  eq('the default helper URL is identical', extConstants.CHATGPT_HELPER_DEFAULT_URL, helperConstants.DEFAULT_HELPER_URL);

  // The error codes are compared in both directions. The helper names its states
  // in its own vocabulary and `HelperError.toBody()` translates them; if a name
  // is missing from the table, or the table disagrees with the extension, the
  // extension silently replaces the code with a generic failure — so a user out
  // of plan allowance would be told "the request failed" instead.
  const extCodes = Object.values(extConstants.ERR);
  /**
   * The helper's name for each state, and the extension's key for the same one.
   *
   * They agree everywhere except `CONFIG_INVALID`, which the extension spells
   * `HELPER_CONFIG_INVALID` because on that side of the fence "config" could
   * mean the user's AI settings. Listing the pair here rather than renaming one
   * side documents the single difference and — because the coverage is checked
   * below — means a code added to the table cannot be forgotten here.
   */
  const CODE_NAMES = {
    HELPER_UNREACHABLE: 'HELPER_UNREACHABLE',
    CHATGPT_NOT_SIGNED_IN: 'CHATGPT_NOT_SIGNED_IN',
    CHATGPT_NO_PLAN_SCOPE: 'CHATGPT_NO_PLAN_SCOPE',
    CHATGPT_NOT_ELIGIBLE: 'CHATGPT_NOT_ELIGIBLE',
    CHATGPT_USAGE_LIMIT: 'CHATGPT_USAGE_LIMIT',
    CHATGPT_UNAVAILABLE: 'CHATGPT_UNAVAILABLE',
    CHATGPT_FAILED: 'CHATGPT_FAILED',
    CONFIG_INVALID: 'HELPER_CONFIG_INVALID',
  };

  check('every code in the table is named for the extension too', Object.keys(helperConstants.CODES).every((k) => k in CODE_NAMES), Object.keys(helperConstants.CODES).filter((k) => !(k in CODE_NAMES)).join(','));
  check('and no name here is missing from the table', Object.keys(CODE_NAMES).every((k) => k in helperConstants.CODES));

  for (const [name, wire] of Object.entries(helperConstants.CODES)) {
    check(`the extension knows the wire code for ${name}`, extCodes.includes(wire), wire);
  }
  for (const [name, extName] of Object.entries(CODE_NAMES)) {
    check(`the helper's ${name} matches ERR.${extName}`, helperConstants.CODES[name] === extConstants.ERR[extName], `${helperConstants.CODES[name]} vs ${extConstants.ERR[extName]}`);
  }
  check('the table has no entry the extension does not have', Object.keys(helperConstants.CODES).length === 8);
  check('HELPER_ERROR_CODES is the table’s wire values', helperConstants.HELPER_ERROR_CODES.join(',') === Object.values(helperConstants.CODES).join(','));

  // The translation itself, not just the table.
  const translated = new errors.HelperError('CHATGPT_USAGE_LIMIT', 'used up', { status: 429 }).toBody();
  eq('a named code goes out as the extension’s wire value', translated.code, 'CHATGPT_USAGE_LIMIT_EXCEEDED');
  eq('and still carries its HTTP status for the local response', new errors.HelperError('CHATGPT_USAGE_LIMIT', 'x', { status: 429 }).status, 429);
  eq('an unrecognised name is passed through, not hidden', new errors.HelperError('SOMETHING_NEW', 'x').toBody().code, 'SOMETHING_NEW');
  for (const wire of helperConstants.HELPER_ERROR_CODES) {
    check(`the extension recognises ${wire} as a helper code`, chatgptClient.KNOWN_HELPER_CODES.includes(wire), wire);
  }
  check(
    'and the extension’s allow-list has nothing the helper cannot send',
    chatgptClient.KNOWN_HELPER_CODES.every((c) => helperConstants.HELPER_ERROR_CODES.includes(c)),
    chatgptClient.KNOWN_HELPER_CODES.join(','),
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  check('the helper exports what the CLI and tests need', typeof helperMain.createHandler === 'function' && typeof helperMain.status === 'function');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'helper/package.json'), 'utf8'));
  // The Connector is versioned independently of the extension: extension releases
  // keep linking to the last Connector package until the Connector itself changes.
  eq('the helper package version matches the version it reports', pkg.version, helperMain.HELPER_VERSION);
  check('the helper is an ES module', pkg.type === 'module');
  check('the helper declares no dependencies', Object.keys(pkg.dependencies || {}).length === 0);
  check('and requires a Node with global fetch and node:test-free crypto', />= ?2[0-9]/.test(pkg.engines.node), pkg.engines.node);

  // The helper must stay runnable on its own: one duplicate constant file, no
  // import of anything under src/.
  const helperSources = ['helper/siwc-helper.js', 'helper/lib/oauth.js', 'helper/lib/responses.js', 'helper/lib/store.js', 'helper/lib/pkce.js', 'helper/lib/guard.js', 'helper/lib/errors.js', 'helper/lib/constants.js'];
  for (const rel of helperSources) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    check(`${rel} does not import from src/`, !/from\s+['"][^'"]*\.\.\/\.\.\/src\//.test(src));
  }

  // -------------------------------------------------------------------------
  console.log('\n[13] The two halves, over real HTTP\n');

  // The real handler, on an ephemeral port, driven by the extension's real
  // client. Nothing here is a re-implementation: this is the actual protocol
  // between the browser and the process, which is the one thing a unit test of
  // either half on its own cannot check.
  const http = require('node:http');
  const client = await load('src/ai/chatgpt-client.js');

  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-http-'));
  process.env.WHATSAPP_COPILOT_HOME = tmpStore;

  const holder = { handler: null };
  const server = http.createServer((req, res) => holder.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  holder.handler = helperMain.createHandler({ port, log: () => {} });
  const base = `http://127.0.0.1:${port}`;

  try {
    const cfg = { helperUrl: base, chatgptModel: 'gpt-6.1-sol' };

    // --- what the panel sees before anybody signs in -----------------------
    const status = await client.helperStatus(cfg);
    eq('the panel finds the helper running', status.helper, 'running');
    eq('and reports nobody signed in', status.signedIn, false);
    eq('as a plain "none", not an error', status.signIn, 'none');
    eq('the helper reports its own version', status.version, helperMain.HELPER_VERSION);
    check('and names the credential file, without reading it', typeof status.credentialFile.path === 'string' && status.credentialFile.path.endsWith('credentials.json'));
    check('the start command names the port it is actually on', status.startCommand.includes(`--port ${port}`), status.startCommand);
    check('no token is anywhere in the status payload', !/access_token|refresh_token|"at"|id_token/i.test(JSON.stringify(status)));

    // --- the sign-in handshake ---------------------------------------------
    const started = await client.startSignIn(cfg);
    check('the sign-in URL is OpenAI’s own authorization endpoint', started.authorizeUrl.startsWith('https://auth.openai.com/'), started.authorizeUrl.slice(0, 50));
    check('and it is flagged as a first registration', started.firstRegistration === true);
    const authParams = new URL(started.authorizeUrl).searchParams;
    eq('the redirect points back at this helper', authParams.get('redirect_uri'), `${base}/auth/callback`);
    eq('and carries the full scope set', authParams.get('scope'), helperConstants.CHATGPT_SCOPES);
    check('with PKCE attached', authParams.get('code_challenge_method') === 'S256' && authParams.get('code_challenge').length === 43);
    check('and a state the helper remembers', authParams.get('state').length >= 32);

    const pending = await client.helperStatus(cfg);
    eq('the panel now sees a sign-in waiting', pending.signIn, 'pending');
    check('and says nobody is signed in yet', pending.signedIn === false);

    // --- inference is refused, with a code the panel can explain -----------
    const checked = await client.checkConnection(cfg);
    eq('the free check fails while signed out', checked.ok, false);
    eq('with the sign-in code, not a generic one', checked.code, extConstants.ERR.CHATGPT_NOT_SIGNED_IN);
    eq('and it never claims to have sent a request', checked.inferenceRequestSent, undefined);

    for (const [label, run] of [
      ['listing models', () => client.listModels(cfg)],
      ['generating a reply', () => client.generate(cfg, { instructions: 'x', input: 'y' })],
    ]) {
      const err = await rejects(run);
      eq(`${label} while signed out carries the sign-in code`, err && err.code, extConstants.ERR.CHATGPT_NOT_SIGNED_IN);
      check(`${label} does not leak a raw HTTP status to the user`, !/401/.test((err && err.message) || ''), err && err.message);
    }

    const test = await client.sendTestRequest(cfg);
    eq('the labelled test request reports failure rather than throwing', test.ok, false);
    eq('with the same actionable code', test.code, extConstants.ERR.CHATGPT_NOT_SIGNED_IN);

    // --- the loopback guards, through a real socket ------------------------
    const raw = async (path, init) => {
      const res = await fetch(`${base}${path}`, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const webOrigin = await raw('/health', { headers: { Origin: 'https://evil.example' } });
    eq('a web page’s request is refused', webOrigin.status, 403);
    const extOrigin = await raw('/health', { headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
    eq('the extension’s own origin is allowed', extOrigin.status, 200);
    // A browser preflight carries the page's Origin, so it is refused by the
    // Origin check before the OPTIONS branch sees it. Either refusal is a
    // refusal — what matters is that it is never answered and never carries a
    // CORS header that would let the page read the reply.
    const preflightRes = await fetch(`${base}/auth/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    check('a CORS preflight is refused, so a page’s JSON POST never happens', preflightRes.status === 403 || preflightRes.status === 405, `got ${preflightRes.status}`);
    check('and no CORS header is ever sent', !preflightRes.headers.get('access-control-allow-origin'));

    const health = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    check('a refused response carries no CORS header either', !health.headers.get('access-control-allow-origin'));

    const formPost = await raw('/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
    eq('a non-JSON body is refused', formPost.status, 415);

    // The extension must never be sent a code it cannot explain, so every
    // failure above is checked against the allow-list rather than just echoed.
    for (const code of [checked.code, test.code]) {
      check(`the panel’s allow-list accepts ${code}`, client.KNOWN_HELPER_CODES.includes(code), code);
    }

    // --- signing out with nothing signed in --------------------------------
    const out = await client.signOut(cfg);
    eq('signing out with no account is not an error', out.revoked, false);
    check('and says what actually happened', /no account/i.test(out.message), out.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.WHATSAPP_COPILOT_HOME;
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`${'='.repeat(56)}\n`);

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  the helper test suite itself failed:', (err && err.stack) || err);
  process.exit(1);
});
