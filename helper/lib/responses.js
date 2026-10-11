/**
 * The inference half: `POST https://api.openai.com/v1/responses`, and the model
 * catalogue for the signed-in account.
 *
 * Three constraints from the published "Models and inference" and "Preview
 * limitations" pages shape everything in this file, and none of them are
 * optional:
 *
 *   1. `stream: true` and `store: false` on every inference request.
 *   2. The endpoint is the public Responses API. ChatGPT's internal
 *      `backend-api` endpoints are explicitly not the mechanism, and are not
 *      touched anywhere in this project.
 *   3. A whole list of ordinary Responses parameters is rejected in this flow —
 *      `temperature`, `max_output_tokens`, `top_p`, `truncation`,
 *      `previous_response_id`, `metadata`, `prompt`, and more. So the request
 *      body here is deliberately tiny. Nothing is "missing" from it: adding
 *      those fields back is what produces
 *      `subscription_sharing_unsupported_capability`.
 *
 * Success is `response.completed`, and only that. A stream that ends without it
 * — a dropped connection, a proxy that truncated the body — is reported as a
 * failure, because the documentation says to treat an interrupted stream as a
 * separate case from a completed one.
 */

import { HelperError, fromProvider } from './errors.js';
import { fetchRetryPreTls } from './net.js';

const API_BASE = 'https://api.openai.com/v1';
const RESPONSES_URL = `${API_BASE}/responses`;
const MODELS_URL = `${API_BASE}/models`;

/** How long a single inference request may take, end to end. */
const INFERENCE_TIMEOUT_MS = 120_000;

/** Bounds for a caller-supplied timeout, matching the extension's own limits. */
const MIN_TIMEOUT_MS = 5_000;

/**
 * Clamp the caller's timeout into a sane window.
 *
 * The extension has its own `timeoutMs` setting and sends it, so that a user who
 * set 30 seconds gets 30 seconds on this path too rather than the helper's
 * default. A missing or nonsensical value falls back to the ceiling instead of
 * being trusted.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampTimeout(value) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return INFERENCE_TIMEOUT_MS;
  return Math.min(INFERENCE_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/**
 * Incremental Server-Sent Events parser.
 *
 * A factory rather than a function because SSE frames do not respect chunk
 * boundaries: a `data:` line can be split anywhere, including between the two
 * newlines that end the frame. Anything that parses each chunk independently
 * works on a fast local test and drops events against a real network.
 *
 * Pure — takes strings, returns objects, touches nothing — so
 * `tools/test-helper.js` can feed it a frame split at every possible offset.
 *
 * @returns {{push: (chunk: string) => Array<{event: string, data: string}>, flush: () => Array<{event: string, data: string}>}}
 */
function createSseParser() {
  let buffer = '';

  /** @param {string} block @returns {{event: string, data: string}|null} */
  function parseBlock(block) {
    let event = '';
    const dataLines = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine;
      if (!line || line.startsWith(':')) continue; // comment / keep-alive
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // Per the SSE spec a single space after the colon is part of the framing,
      // not the value.
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join('\n') };
  }

  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      // Normalised after appending, so a CRLF straddling two chunks is still
      // seen as one terminator.
      buffer = buffer.replace(/\r\n/g, '\n');
      const out = [];
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseBlock(block);
        if (parsed) out.push(parsed);
        idx = buffer.indexOf('\n\n');
      }
      return out;
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (!rest) return [];
      const parsed = parseBlock(rest);
      return parsed ? [parsed] : [];
    },
  };
}

/**
 * Turn one SSE frame into a typed event.
 *
 * @param {{event: string, data: string}} frame
 * @returns {{kind: string, payload: any}}
 */
function classifyFrame(frame) {
  const data = frame.data;
  if (data === '[DONE]') return { kind: 'done', payload: null };
  let payload;
  try {
    payload = JSON.parse(data);
  } catch (err) {
    return { kind: 'unparsable', payload: data.slice(0, 200) };
  }
  const type = (payload && payload.type) || frame.event || '';
  switch (type) {
    case 'response.output_text.delta':
      return { kind: 'delta', payload };
    case 'response.completed':
      return { kind: 'completed', payload };
    case 'response.failed':
      return { kind: 'failed', payload };
    case 'response.incomplete':
      return { kind: 'incomplete', payload };
    case 'error':
      return { kind: 'error', payload };
    default:
      return { kind: 'other', payload };
  }
}

/**
 * Pull the assistant's text out of a finished Responses object.
 *
 * @param {any} response
 * @returns {string}
 */
function extractOutputText(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const piece of content) {
      if (!piece) continue;
      // `output_text` is the Responses shape; `text` is accepted as well because
      // some SDK versions re-serialise it that way.
      if ((piece.type === 'output_text' || piece.type === 'text') && typeof piece.text === 'string') {
        parts.push(piece.text);
      }
    }
  }
  return parts.join('').trim();
}

/**
 * The body sent for one inference request. Kept separate so a test can assert
 * exactly which keys are present — the subset matters as much as the values.
 *
 * @param {{model: string, instructions: string, input: string}} args
 * @returns {object}
 */
function buildResponsesBody(args) {
  return {
    model: args.model,
    // The system prompt goes in `instructions`. Explicit system-role items in
    // `input` are rejected in this flow.
    instructions: args.instructions,
    // The subscription route wants `input` as a list of messages; a bare string
    // is rejected.
    input: Array.isArray(args.input)
      ? args.input
      : [{ role: 'user', content: [{ type: 'input_text', text: String(args.input) }] }],
    store: false,
    stream: true,
  };
}

/**
 * Run one inference request and return the finished text.
 *
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.model
 * @param {string} opts.instructions
 * @param {string} opts.input
 * @param {AbortSignal} [opts.signal] aborted when the extension goes away
 * @param {number} [opts.timeoutMs] the extension's own timeout, if it set one
 * @returns {Promise<{text: string, model: string, usage: object|null, responseId: string, elapsedMs: number}>}
 */
async function generate(opts) {
  const startedAt = Date.now();
  const body = buildResponsesBody(opts);

  const budgetMs = clampTimeout(opts.timeoutMs);
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res;
  try {
    res = await fetchRetryPreTls(RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (opts.signal && opts.signal.aborted) {
      throw new HelperError('CHATGPT_FAILED', 'The request was cancelled.', { status: 499, detail: 'client aborted' });
    }
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new HelperError(
      'CHATGPT_UNAVAILABLE',
      timedOut ? 'OpenAI did not finish the reply in time.' : 'Could not reach OpenAI from this computer.',
      { status: 503, retryable: true, detail: (err && err.message) || 'network error' },
    );
  }

  if (!res.ok) {
    const parsed = await safeJson(res);
    throw fromProvider(res.status, parsed, res.headers.get('x-request-id') || '');
  }

  const requestId = res.headers.get('x-request-id') || '';
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let streamed = '';
  let completed = null;
  let failure = null;

  /** @param {Array<{kind: string, payload: any}>} events */
  function consume(events) {
    for (const event of events) {
      if (event.kind === 'delta') {
        const delta = event.payload && event.payload.delta;
        if (typeof delta === 'string') streamed += delta;
      } else if (event.kind === 'completed') {
        completed = event.payload && event.payload.response ? event.payload.response : event.payload;
      } else if (event.kind === 'failed') {
        const response = event.payload && event.payload.response ? event.payload.response : event.payload;
        failure = (response && response.error) || (event.payload && event.payload.error) || null;
      } else if (event.kind === 'incomplete') {
        const response = event.payload && event.payload.response ? event.payload.response : event.payload;
        failure = {
          code: 'response_incomplete',
          message: (response && response.incomplete_details && response.incomplete_details.reason) || 'incomplete',
        };
      } else if (event.kind === 'error') {
        // A top-level `error` frame can arrive mid-stream, and this is how a
        // plan-usage limit surfaces when it is hit while the reply is being
        // written.
        failure = (event.payload && event.payload.error) || event.payload;
      }
    }
  }

  if (!res.body) {
    throw new HelperError('CHATGPT_FAILED', 'OpenAI returned an empty stream.', { status: 502, requestId });
  }

  try {
    for await (const chunk of res.body) {
      consume(parser.push(decoder.decode(chunk, { stream: true })).map(classifyFrame));
      if (failure || completed) break;
    }
    if (!failure && !completed) {
      consume(parser.flush().map(classifyFrame));
    }
  } catch (err) {
    if (opts.signal && opts.signal.aborted) {
      throw new HelperError('CHATGPT_FAILED', 'The request was cancelled.', { status: 499, detail: 'client aborted' });
    }
    throw new HelperError('CHATGPT_UNAVAILABLE', 'The connection to OpenAI was interrupted mid-reply.', {
      status: 503,
      retryable: true,
      detail: (err && err.message) || 'stream error',
      requestId,
    });
  }

  if (failure) {
    // `failure` may be a documented structured error, or the bare
    // `{ detail: "..." }` shape direct-route admission is documented to return.
    throw fromProvider(statusFromFailure(failure), failure, requestId);
  }
  if (!completed) {
    throw new HelperError(
      'CHATGPT_UNAVAILABLE',
      'The reply was cut off before it finished, so nothing was returned.',
      { status: 503, retryable: true, detail: 'stream ended without response.completed', requestId },
    );
  }

  const text = extractOutputText(completed) || streamed.trim();
  if (!text) {
    throw new HelperError('CHATGPT_FAILED', 'OpenAI completed the request but returned no text.', {
      status: 502,
      requestId,
    });
  }

  return {
    text,
    model: (completed && completed.model) || opts.model,
    usage: (completed && completed.usage) || null,
    responseId: (completed && completed.id) || '',
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The HTTP status to attribute to a mid-stream failure object.
 *
 * @param {any} failure
 * @returns {number}
 */
function statusFromFailure(failure) {
  const code = failure && typeof failure.code === 'string' ? failure.code : '';
  switch (code) {
    case 'subscription_sharing_user_not_eligible':
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return 403;
    case 'subscription_sharing_usage_limit_exceeded':
      return 429;
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return 503;
    case 'subscription_sharing_unsupported_capability':
      return 400;
    case 'subscription_sharing_invalid_user':
      return 401;
    default:
      return 502;
  }
}

/**
 * The models this account may actually use.
 *
 * The documentation says to fetch `/v1/models` with the account's access token,
 * keep the entries whose `visibility` is `"list"`, and send the chosen `slug` as
 * `model` — not the `display_name`, which is for people.
 *
 * If no entry reports a `visibility` field at all, that is reported rather than
 * guessed around: an empty list here means "this account's catalogue does not
 * look the way the documentation describes", and the caller says so instead of
 * showing a list that might include models the account cannot use.
 *
 * @param {object} opts
 * @param {string} opts.accessToken
 * @returns {Promise<{models: Array<{slug: string, displayName: string}>, total: number, visibilityReported: boolean}>}
 */
async function listModels(opts) {
  let res;
  try {
    res = await fetchRetryPreTls(MODELS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${opts.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HelperError('CHATGPT_UNAVAILABLE', 'Could not reach OpenAI to list the models on this account.', {
      status: 503,
      retryable: true,
      detail: (err && err.message) || 'network error',
    });
  }

  if (!res.ok) {
    const parsed = await safeJson(res);
    throw fromProvider(res.status, parsed, res.headers.get('x-request-id') || '');
  }

  const body = await safeJson(res);
  // The catalogue is a top-level `models` array (older code read `data`).
  const all = body && Array.isArray(body.models) ? body.models : body && Array.isArray(body.data) ? body.data : [];
  const visibilityReported = all.some((m) => m && typeof m.visibility === 'string');

  const models = all
    .filter((m) => m && typeof m === 'object')
    .filter((m) => (visibilityReported ? m.visibility === 'list' : true))
    .map((m) => ({
      slug: String(m.slug || m.id || '').trim(),
      displayName: String(m.display_name || m.slug || m.id || '').trim(),
    }))
    .filter((m) => m.slug);

  return { models, total: all.length, visibilityReported };
}

/** @param {Response} res @returns {Promise<any>} */
async function safeJson(res) {  try {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      return { detail: text.slice(0, 400) };
    }
  } catch (err) {
    return null;
  }
}

export {
  API_BASE,
  RESPONSES_URL,
  MODELS_URL,
  INFERENCE_TIMEOUT_MS,
  clampTimeout,
  createSseParser,
  classifyFrame,
  extractOutputText,
  buildResponsesBody,
  generate,
  listModels,
};
