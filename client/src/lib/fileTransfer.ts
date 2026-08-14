// DataChannel file-transfer protocol (JSON text frames, like hello/text).
// Files flow peer-to-peer only — the signaling server never sees them,
// preserving the zero-retention invariant.

import { base64ToBuffer, bufferToBase64 } from './base64';

// FILE_CHUNK_BYTES caps each DataChannel frame well below the browser's
// per-message limit (~256KB in Chromium) while keeping per-frame overhead
// reasonable for large documents.
export const FILE_CHUNK_BYTES = 64 * 1024;

// MAX_FILE_BYTES bounds a single transfer so a malicious peer cannot
// declare an absurd size and exhaust the receiver's memory.
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const FILE_META_KIND = 'file-meta';
export const FILE_CHUNK_KIND = 'file-chunk';

/** File description announced before the chunks flow. */
export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunks: number;
}

/** One ordered slice of the file (base64-encoded bytes). */
export interface FileChunk {
  id: string;
  seq: number;
  data: string;
}

export type FileFrame =
  | { kind: typeof FILE_META_KIND; data: FileMeta }
  | { kind: typeof FILE_CHUNK_KIND; data: FileChunk };

/**
 * Validates an inbound file-meta frame. Returns null when malformed or
 * oversized — a peer declaring an absurd size must be rejected, not
 * allocated.
 */
export function parseFileMeta(raw: unknown): FileMeta | null {
  const m = raw as FileMeta;
  if (!m || typeof m !== 'object') return null;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) return null;
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 255)
    return null;
  if (typeof m.mimeType !== 'string' || m.mimeType.length > 255) return null;
  if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE_BYTES) return null;
  if (!Number.isSafeInteger(m.chunks) || m.chunks < 1) return null;
  return m;
}

/** Splits file bytes into meta + ordered chunks (sender side). */
export function splitFile(
  id: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): { meta: FileMeta; chunks: FileChunk[] } {
  const chunks = Math.max(1, Math.ceil(bytes.length / FILE_CHUNK_BYTES));
  const meta: FileMeta = { id, name, size: bytes.length, mimeType, chunks };
  const out: FileChunk[] = [];
  for (let seq = 0; seq < chunks; seq++) {
    const start = seq * FILE_CHUNK_BYTES;
    const end = Math.min(start + FILE_CHUNK_BYTES, bytes.length);
    out.push({ id, seq, data: bufferToBase64(bytes.subarray(start, end)) });
  }
  return { meta, chunks: out };
}

/**
 * Reassembles a file from ordered chunks (receiver side).
 * The channel is ordered, so chunks must arrive in sequence; anything
 * else is protocol corruption and throws (the caller fails the transfer).
 */
export class FileReceiver {
  private readonly buffer: Uint8Array;
  private received = 0;
  private nextSeq = 0;

  constructor(readonly meta: FileMeta) {
    this.buffer = new Uint8Array(meta.size);
  }

  get progress(): number {
    return this.meta.size === 0 ? 1 : this.received / this.meta.size;
  }

  addChunk(chunk: FileChunk): { complete: boolean } {
    if (chunk.id !== this.meta.id) throw new Error('chunk id mismatch');
    if (chunk.seq !== this.nextSeq) throw new Error('chunk out of order');
    if (chunk.seq >= this.meta.chunks) throw new Error('too many chunks');
    const bytes = new Uint8Array(base64ToBuffer(chunk.data));
    const end = Math.min(this.received + bytes.length, this.meta.size);
    this.buffer.set(bytes, this.received);
    this.received = end;
    this.nextSeq++;
    return { complete: this.nextSeq >= this.meta.chunks };
  }

  /** The reassembled file as a Blob (only valid once complete). */
  toBlob(): Blob {
    if (this.nextSeq < this.meta.chunks) throw new Error('file incomplete');
    return new Blob([this.buffer], { type: this.meta.mimeType });
  }
}
