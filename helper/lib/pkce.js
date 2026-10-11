/**
 * PKCE, random values, and this host's stable identifier.
 *
 * Pure functions over `node:crypto` — no I/O, no state — so `tools/test-helper.js`
 * can check the exact bytes that go on the wire.
 *
 * Why this file exists at all: the ChatGPT-plan flow is a *public client* flow.
 * There is no client secret to fall back on, so PKCE is the only thing binding
 * an authorization code to the process that asked for it. Getting `S256` wrong
 * (sending the verifier as the challenge, or padding the base64) does not fail
 * loudly at build time — it fails at the token endpoint, at the very end of a
 * flow the user has already consented to.
 */

import { randomBytes, createHash, randomUUID } from 'node:crypto';

/**
 * base64url without padding — RFC 4648 §5.
 *
 * The padding is not cosmetic. `https://auth.openai.com` is documented as
 * requiring "the base64url-encoded SHA-256 digest of the PKCE verifier, without
 * padding", and a trailing `=` changes the digest the server computes.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE verifier/challenge pair.
 *
 * 64 random bytes → 86 base64url characters, inside RFC 7636's 43–128 window and
 * drawn only from its unreserved alphabet.
 *
 * @returns {{verifier: string, challenge: string, method: 'S256'}}
 */
function createPkce() {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

/**
 * A fresh `state` or OIDC `nonce`.
 * @param {number} [bytes]
 * @returns {string}
 */
function randomUrlSafe(bytes = 32) {
  return base64url(randomBytes(bytes));
}

/**
 * This host's stable, opaque identifier.
 *
 * `urn:uuid:` is one of the three formats the documentation accepts, and the
 * only one that needs no key material. The documentation is explicit that a host
 * ID "is not an authentication credential", so a UUID is not a weak choice here
 * — it is not standing in for a secret, it is naming an installation.
 *
 * It must be stable across restarts: a new host ID on every launch would make
 * every sign-in look like a new host to OpenAI, and the docs are clear that
 * "restarting the tool or signing in again does not by itself create a new host".
 *
 * @returns {string}
 */
function newHostId() {
  return `urn:uuid:${randomUUID()}`;
}

export { base64url, createPkce, randomUrlSafe, newHostId };
