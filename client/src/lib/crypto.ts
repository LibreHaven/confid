// Zero-retention, end-to-end encryption primitives.
//
// Key exchange: ECDH P-256 → HKDF-SHA256 → AES-GCM.
// All cryptography runs in the browser; the server never sees key material.

// AES_GCM_NONCE_BYTES is the length of the random nonce prepended to
// every ciphertext (12 bytes is the recommended size for AES-GCM).
const AES_GCM_NONCE_BYTES = 12;

// FINGERPRINT_GROUPS is how many hex chars each fingerprint group has.
const FINGERPRINT_GROUP_BYTES = 4;

/** Generate an ECDH P-256 key pair (extractable for key export). */
export function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ]);
}

/** Export a public key as JWK for transport over signaling. */
export async function exportPublicKey(jwk: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', jwk);
}

/** Import a peer's public key from JWK (extractable: fingerprints need SPKI). */
export function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/**
 * Derive the shared AES-GCM session key.
 *
 * @param myPrivate  this peer's ECDH private key
 * @param peerPublic the other peer's ECDH public key
 * @param salt       random per-session salt (both peers agree via signaling)
 * @param info       context string binding the key to this session
 */
export async function deriveSessionKey(
  myPrivate: CryptoKey,
  peerPublic: CryptoKey,
  salt: ArrayBuffer,
  info: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublic },
    myPrivate,
    256,
  );
  // HKDF deriveKey requires a CryptoKey as its base key material.
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a message. Output layout: [12-byte nonce][ciphertext+tag].
 * The nonce is random per message; AES-GCM authenticates the ciphertext.
 */
export async function encryptMessage(
  key: CryptoKey,
  plaintext: string,
): Promise<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(AES_GCM_NONCE_BYTES + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ciphertext), AES_GCM_NONCE_BYTES);
  return out.buffer;
}

/** Decrypt a message produced by {@link encryptMessage}. Throws on tampering. */
export async function decryptMessage(key: CryptoKey, data: ArrayBuffer): Promise<string> {
  const buf = new Uint8Array(data);
  if (buf.byteLength <= AES_GCM_NONCE_BYTES) {
    throw new Error('ciphertext too short');
  }
  const nonce = buf.slice(0, AES_GCM_NONCE_BYTES);
  const ciphertext = buf.slice(AES_GCM_NONCE_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Fingerprint of a public key: lowercase hex of SHA-256 over the raw
 * SPKI bytes, grouped for human comparison.
 */
export async function fingerprintOf(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const digest = await crypto.subtle.digest('SHA-256', spki);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.match(new RegExp(`.{1,${FINGERPRINT_GROUP_BYTES}}`, 'g'))!.join(' ');
}

/** Generate a random hex salt string for HKDF (sent via signaling). */
export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
