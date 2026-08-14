// Binary <-> base64 helpers shared by the chat and file-transfer codecs.

/**
 * Encodes bytes as base64 (DataChannel frames are text-friendly).
 * Accepts an ArrayBuffer or any Uint8Array view (including subarray
 * views, whose .buffer spans the whole underlying array — the view's
 * own length is what matters).
 */
export function bufferToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decodes a base64 string into bytes. */
export function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
