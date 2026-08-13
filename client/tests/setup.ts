import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

// jsdom does not implement Web Crypto; Node's implementation is a
// standards-compliant substitute for unit tests.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}
