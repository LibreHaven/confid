import {
  deriveSessionKey,
  decryptMessage,
  encryptMessage,
  exportPublicKey,
  fingerprintOf,
  generateKeyPair,
  importPublicKey,
  randomSalt,
} from './crypto';

describe('crypto key exchange', () => {
  it('both peers derive the same session key', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const salt = new TextEncoder().encode(randomSalt());

    const aliceKey = await deriveSessionKey(
      alice.privateKey,
      bob.publicKey,
      salt,
      'confid-session-v1',
    );
    const bobKey = await deriveSessionKey(
      bob.privateKey,
      alice.publicKey,
      salt,
      'confid-session-v1',
    );

    // Session keys are intentionally non-extractable; equivalence is proven
    // by encrypting with one and decrypting with the other.
    const cipher = await encryptMessage(aliceKey, 'shared secret');
    expect(await decryptMessage(bobKey, cipher)).toBe('shared secret');
  });

  it('derived keys differ when salt differs', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key1 = await deriveSessionKey(
      alice.privateKey,
      bob.publicKey,
      new TextEncoder().encode('salt-a'),
      'confid-session-v1',
    );
    const key2 = await deriveSessionKey(
      alice.privateKey,
      bob.publicKey,
      new TextEncoder().encode('salt-b'),
      'confid-session-v1',
    );
    const cipher = await encryptMessage(key1, 'salt-bound secret');
    await expect(decryptMessage(key2, cipher)).rejects.toThrow();
  });
});

describe('crypto message encryption', () => {
  async function sessionKeys() {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const salt = new TextEncoder().encode(randomSalt());
    return {
      alice: await deriveSessionKey(
        alice.privateKey,
        bob.publicKey,
        salt,
        'confid-session-v1',
      ),
      bob: await deriveSessionKey(
        bob.privateKey,
        alice.publicKey,
        salt,
        'confid-session-v1',
      ),
    };
  }

  it('round-trips a message', async () => {
    const { alice, bob } = await sessionKeys();
    const cipher = await encryptMessage(alice, '合同内容: 保密条款 3.2');
    const plain = await decryptMessage(bob, cipher);
    expect(plain).toBe('合同内容: 保密条款 3.2');
  });

  it('rejects tampered ciphertext', async () => {
    const { bob } = await sessionKeys();
    const cipher = new Uint8Array(await encryptMessage(bob, 'secrets'));
    const last = cipher.length - 1;
    cipher[last] = (cipher[last] ?? 0) ^ 0xff; // flip one bit in the tag
    await expect(decryptMessage(bob, cipher.buffer)).rejects.toThrow();
  });

  it('rejects ciphertext shorter than the nonce', async () => {
    const { bob } = await sessionKeys();
    await expect(decryptMessage(bob, new Uint8Array(4).buffer)).rejects.toThrow();
  });

  it('does not decrypt under a different session key', async () => {
    const { alice } = await sessionKeys();
    const other = await sessionKeys();
    const cipher = await encryptMessage(alice, 'top secret');
    await expect(decryptMessage(other.alice, cipher)).rejects.toThrow();
  });
});

describe('crypto fingerprints', () => {
  it('is stable for the same key and differs across keys', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const fa = await fingerprintOf(a.publicKey);
    const fa2 = await fingerprintOf(a.publicKey);
    const fb = await fingerprintOf(b.publicKey);
    expect(fa).toBe(fa2);
    expect(fa).not.toBe(fb);
  });

  it('survives JWK export/import round-trip', async () => {
    const kp = await generateKeyPair();
    const jwk = await exportPublicKey(kp.publicKey);
    const imported = await importPublicKey(jwk);
    expect(await fingerprintOf(imported)).toBe(await fingerprintOf(kp.publicKey));
  });
});
