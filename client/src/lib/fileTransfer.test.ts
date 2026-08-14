import { describe, it, expect } from 'vitest';
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  FileReceiver,
  parseFileMeta,
  splitFile,
} from './fileTransfer';

/** Deterministic pseudo-random bytes for round-trip tests. */
function seededBytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

/** jsdom's Blob lacks arrayBuffer(); FileReader is the supported path. */
function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Feeds every chunk from splitFile into a receiver and returns the Blob. */
async function roundTrip(bytes: Uint8Array, name = '合同.pdf', mime = 'application/pdf') {
  const { meta, chunks } = splitFile('file-1', name, mime, bytes);
  const receiver = new FileReceiver(meta);
  let complete = false;
  for (const chunk of chunks) {
    complete = receiver.addChunk(chunk).complete;
  }
  expect(complete).toBe(true);
  return { meta, bytes: await blobToBytes(receiver.toBlob()) };
}

describe('splitFile', () => {
  it('splits a small file into a single chunk', () => {
    const bytes = seededBytes(100);
    const { meta, chunks } = splitFile('f1', 'a.txt', 'text/plain', bytes);
    expect(meta).toEqual({
      id: 'f1',
      name: 'a.txt',
      size: 100,
      mimeType: 'text/plain',
      chunks: 1,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ id: 'f1', seq: 0 });
  });

  it('splits a large file into ceiling(size / chunk) chunks', () => {
    const size = FILE_CHUNK_BYTES * 3 + 123;
    const { meta, chunks } = splitFile(
      'f2',
      'big.bin',
      'application/octet-stream',
      seededBytes(size),
    );
    expect(meta.chunks).toBe(4);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
  });

  it('handles an empty file as one empty chunk', () => {
    const { meta, chunks } = splitFile(
      'f3',
      'empty.txt',
      'text/plain',
      new Uint8Array(0),
    );
    expect(meta.size).toBe(0);
    expect(meta.chunks).toBe(1);
    expect(chunks).toHaveLength(1);
  });
});

describe('FileReceiver round-trip', () => {
  it('reassembles a multi-chunk binary file byte-for-byte', async () => {
    const bytes = seededBytes(FILE_CHUNK_BYTES * 2 + 777, 42);
    const { bytes: out } = await roundTrip(bytes);
    expect(out).toEqual(bytes);
  });

  it('preserves UTF-8 names and Chinese content', async () => {
    const bytes = new TextEncoder().encode('保密条款 3.2：已确认 🤝');
    const { meta, bytes: out } = await roundTrip(
      bytes,
      '保密合同.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(meta.name).toBe('保密合同.docx');
    expect(new TextDecoder().decode(out)).toBe('保密条款 3.2：已确认 🤝');
  });

  it('tracks progress across chunks', () => {
    const bytes = seededBytes(FILE_CHUNK_BYTES * 2);
    const { meta, chunks } = splitFile('f4', 'p.bin', 'application/octet-stream', bytes);
    const receiver = new FileReceiver(meta);
    expect(receiver.progress).toBe(0);
    receiver.addChunk(chunks[0]!);
    expect(receiver.progress).toBeCloseTo(0.5);
    receiver.addChunk(chunks[1]!);
    expect(receiver.progress).toBe(1);
  });
});

describe('parseFileMeta validation', () => {
  const good = {
    id: 'abc',
    name: 'f.pdf',
    size: 10,
    mimeType: 'application/pdf',
    chunks: 1,
  };

  it('accepts a valid meta', () => {
    expect(parseFileMeta(good)).toEqual(good);
  });

  it('rejects oversized files', () => {
    expect(parseFileMeta({ ...good, size: MAX_FILE_BYTES + 1 })).toBeNull();
  });

  it('rejects negative, fractional, or missing sizes', () => {
    expect(parseFileMeta({ ...good, size: -1 })).toBeNull();
    expect(parseFileMeta({ ...good, size: 1.5 })).toBeNull();
    expect(parseFileMeta({ ...good, size: undefined })).toBeNull();
  });

  it('rejects missing or empty name / id', () => {
    expect(parseFileMeta({ ...good, name: '' })).toBeNull();
    expect(parseFileMeta({ ...good, id: '' })).toBeNull();
    expect(parseFileMeta({ ...good, name: undefined })).toBeNull();
  });

  it('rejects invalid chunk counts and non-object payloads', () => {
    expect(parseFileMeta({ ...good, chunks: 0 })).toBeNull();
    expect(parseFileMeta({ ...good, chunks: 1.5 })).toBeNull();
    expect(parseFileMeta(null)).toBeNull();
    expect(parseFileMeta('nope')).toBeNull();
  });
});

describe('FileReceiver corruption guards', () => {
  it('rejects a chunk from a different file id', () => {
    const bytes = seededBytes(10);
    const { meta, chunks } = splitFile('a', 'f.txt', 'text/plain', bytes);
    const receiver = new FileReceiver(meta);
    expect(() => receiver.addChunk({ ...chunks[0]!, id: 'other' })).toThrow(
      'chunk id mismatch',
    );
  });

  it('rejects out-of-order chunks', () => {
    const bytes = seededBytes(FILE_CHUNK_BYTES + 5);
    const { meta, chunks } = splitFile('b', 'f.txt', 'text/plain', bytes);
    const receiver = new FileReceiver(meta);
    expect(() => receiver.addChunk(chunks[1]!)).toThrow('chunk out of order');
  });

  it('rejects more chunks than the meta declared', () => {
    const bytes = seededBytes(10);
    const { meta, chunks } = splitFile('c', 'f.txt', 'text/plain', bytes);
    const receiver = new FileReceiver(meta);
    receiver.addChunk(chunks[0]!);
    expect(() => receiver.addChunk({ ...chunks[0]!, seq: 1 })).toThrow('too many chunks');
  });

  it('toBlob throws before completion', () => {
    const bytes = seededBytes(FILE_CHUNK_BYTES + 5);
    const { meta, chunks } = splitFile('d', 'f.txt', 'text/plain', bytes);
    const receiver = new FileReceiver(meta);
    receiver.addChunk(chunks[0]!);
    expect(() => receiver.toBlob()).toThrow('file incomplete');
  });
});
