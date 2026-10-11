/**
 * Loopback request guards.
 *
 * This server listens on `127.0.0.1`, which stops the local network reaching it
 * but stops nothing else. Two things on the *same machine* can still talk to it:
 * a web page the user has open, and anything that can make the browser resolve a
 * hostname to `127.0.0.1`.
 *
 * Both are answered here.
 *
 *   DNS rebinding — a page on `evil.example` whose DNS has been repointed at
 *   `127.0.0.1` can issue same-origin requests to this port. The defence is the
 *   `Host` header: a request that reached us by name carries that name, and a
 *   name that is not the loopback address itself is refused. Without this check
 *   the whole `127.0.0.1` bind is theatre.
 *
 *   Cross-site requests — a page can `fetch()` this port. Two independent things
 *   stop it reading anything: the `Origin` check refuses a web origin outright,
 *   and no `Access-Control-Allow-Origin` header is ever sent, so the browser
 *   discards every response that does get through. On top of both, the JSON
 *   endpoints require `Content-Type: application/json`, which is what forces a
 *   CORS preflight in the first place — and the preflight is refused too, since
 *   it carries the same `Origin`. The `Origin` check is the layer that makes an
 *   accidental future mistake (someone adding a permissive CORS header)
 *   non-fatal.
 *
 * The extension itself is not affected by any of this. It holds a host
 * permission for `http://127.0.0.1/*`, so Chrome does not apply CORS to its
 * requests at all, and its `Origin` is `chrome-extension://…`.
 */

/** Hostnames that genuinely mean "this machine". */
const ALLOWED_HOSTNAMES = Object.freeze(['127.0.0.1', '[::1]', '::1']);

/**
 * Is the `Host` header this server's own address?
 *
 * The port is checked too, so a request aimed at a *different* local port cannot
 * be replayed here by a service worker or a proxy.
 *
 * @param {string|undefined} hostHeader
 * @param {number} port
 * @returns {boolean}
 */
function hostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').trim();
  if (!host) return false;
  const idx = host.lastIndexOf(':');
  if (idx === -1) return false;
  const name = host.slice(0, idx).toLowerCase();
  const hostPort = host.slice(idx + 1);
  if (String(port) !== hostPort) return false;
  return ALLOWED_HOSTNAMES.includes(name);
}

/**
 * May a request carry this `Origin`?
 *
 * Absent is allowed — that is curl, a test script, and Node's own fetch. An
 * extension origin is allowed. A web origin is not, and neither is `null` as a
 * *fallback for a web origin*: `null` is what a sandboxed iframe sends, and the
 * preflight refusal is what actually stops it. Keeping `null` out of the
 * allow-list is the belt to that pair of braces.
 *
 * @param {string|undefined} originHeader
 * @returns {boolean}
 */
function originAllowed(originHeader) {
  if (originHeader === undefined || originHeader === null || originHeader === '') return true;
  return String(originHeader).startsWith('chrome-extension://');
}

/**
 * Is this a JSON request body?
 *
 * Required on every state-changing endpoint, because requiring it is what makes
 * the browser send a preflight — and the preflight is refused.
 *
 * @param {string|undefined} contentTypeHeader
 * @returns {boolean}
 */
function isJsonRequest(contentTypeHeader) {
  return String(contentTypeHeader || '')
    .toLowerCase()
    .startsWith('application/json');
}

export { ALLOWED_HOSTNAMES, hostAllowed, originAllowed, isJsonRequest };
