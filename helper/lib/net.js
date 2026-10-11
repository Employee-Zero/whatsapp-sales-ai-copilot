/**
 * fetch with a bounded retry for one failure only: the connection was reset
 * before TLS was established.
 *
 * Behind a system proxy (Stash, Surge) the first connection through the tunnel
 * is sometimes reset before the TLS handshake finishes. Node reports that as
 * ECONNRESET with the message "Client network socket disconnected before secure
 * TLS connection was established". Nothing of the request — headers or body —
 * has left this machine at that point, so sending it again cannot duplicate
 * anything, including a single-use authorization code.
 *
 * Everything else is NOT retried: timeouts, HTTP responses of any status,
 * resets that happen after the handshake, and unknown errors. Any of those may
 * mean the server already saw the request.
 *
 * Logs carry only the hostname, the attempt number and the error code.
 */

let sink = null;
/** @param {(line: string) => void} fn where the (redacted) retry lines go */
function setNetLogger(fn) {
  sink = fn;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [150, 300, 600, 1000];
const TOTAL_BUDGET_MS = 8000;

/**
 * @param {any} err
 * @returns {boolean} true only when the error proves the request was never sent
 */
function isPreTlsReset(err) {
  const cause = err && err.cause ? err.cause : err;
  const code = cause && cause.code;
  const message = String((cause && cause.message) || '');
  return code === 'ECONNRESET' && /before secure TLS connection was established/i.test(message);
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {Promise<Response>}
 */
async function fetchRetryPreTls(url, init, opts = {}) {
  const startedAt = Date.now();
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (err) {
    host = 'unknown';
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const wait = BACKOFF_MS[attempt - 1];
      const budgetLeft = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (!isPreTlsReset(err) || attempt >= MAX_ATTEMPTS || wait === undefined || budgetLeft <= wait) throw err;
      if (init && init.signal && init.signal.aborted) throw err;
      const emit = opts.log || sink;
      if (emit) emit(`Network: pre-TLS reset reaching ${host} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export { fetchRetryPreTls, isPreTlsReset, setNetLogger };
