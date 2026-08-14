import { describe, it, expect } from 'vitest';
import {
  initialState,
  inviteUrlFor,
  sessionReducer,
  type SessionEvent,
  type SessionState,
} from './sessionMachine';

/** Drives a list of events through the reducer, asserting the final phase. */
function drive(events: SessionEvent[], from: SessionState = initialState) {
  return events.reduce(sessionReducer, from);
}

describe('session machine — creator path', () => {
  it('idle → ready → creating → waiting → handshaking → verifying → active', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'CREATE' },
      { type: 'CREATED', roomId: 'x7k2p9' },
      { type: 'PEER_JOINED' },
      { type: 'PUBLIC_KEYS_READY', remoteFingerprint: 'a1 b2 c3' },
      { type: 'VERIFY', match: true },
    ]);
    expect(s.phase).toBe('active');
  });

  it('waiting carries roomId and invite URL', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'CREATE' },
      { type: 'CREATED', roomId: 'x7k2p9' },
    ]);
    expect(s).toMatchObject({
      phase: 'waiting',
      roomId: 'x7k2p9',
      inviteUrl: expect.stringContaining('#/join/x7k2p9'),
    });
  });
});

describe('session machine — joiner path', () => {
  it('idle → ready → joining → handshaking → verifying → active', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'JOIN', roomId: 'x7k2p9' },
      { type: 'JOINED' },
      { type: 'OFFER_RECEIVED' },
      { type: 'PUBLIC_KEYS_READY', remoteFingerprint: 'd4 e5 f6' },
      { type: 'VERIFY', match: true },
    ]);
    expect(s.phase).toBe('active');
  });

  it('joiner moves to handshaking on offer even before joined ack', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'JOIN', roomId: 'x7k2p9' },
      { type: 'OFFER_RECEIVED' },
    ]);
    expect(s.phase).toBe('handshaking');
  });
});

describe('session machine — guards and failure recovery', () => {
  it('fingerprint mismatch fails the session', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'CREATE' },
      { type: 'CREATED', roomId: 'x7k2p9' },
      { type: 'PEER_JOINED' },
      { type: 'PUBLIC_KEYS_READY', remoteFingerprint: 'a1 b2 c3' },
      { type: 'VERIFY', match: false },
    ]);
    expect(s).toEqual({ phase: 'failed', reason: 'fingerprint mismatch' });
  });

  it('server errors fail the session with the code', () => {
    const s = drive([
      { type: 'CONNECTED' },
      { type: 'JOIN', roomId: 'zzz' },
      { type: 'ERROR', code: 'room_not_found' },
    ]);
    expect(s).toEqual({ phase: 'failed', reason: 'room_not_found' });
  });

  it('handshake and verification timeouts fail', () => {
    const hs = drive([
      { type: 'CONNECTED' },
      { type: 'CREATE' },
      { type: 'CREATED', roomId: 'x7k2p9' },
      { type: 'PEER_JOINED' },
      { type: 'TIMEOUT' },
    ]);
    expect(hs.phase).toBe('failed');

    const vs = drive(
      [{ type: 'PUBLIC_KEYS_READY', remoteFingerprint: 'a1 b2 c3' }, { type: 'TIMEOUT' }],
      { phase: 'handshaking', role: 'creator' },
    );
    expect(vs.phase).toBe('failed');
  });

  it('peer leaving from any connected phase closes the session', () => {
    for (const from of [
      { phase: 'waiting', roomId: 'x', inviteUrl: 'u' },
      { phase: 'joining', roomId: 'x' },
      { phase: 'handshaking', role: 'joiner' },
      { phase: 'verifying', remoteFingerprint: 'f' },
      { phase: 'active' },
    ] as SessionState[]) {
      expect(sessionReducer(from, { type: 'PEER_LEFT' }).phase).toBe('closed');
    }
  });

  it('illegal events are ignored (guards)', () => {
    expect(sessionReducer(initialState, { type: 'PEER_LEFT' })).toBe(initialState);
    expect(
      sessionReducer({ phase: 'idle' }, { type: 'CREATED', roomId: 'x' }).phase,
    ).toBe('idle');
    expect(sessionReducer({ phase: 'ready' }, { type: 'TIMEOUT' }).phase).toBe('ready');
    // VERIFY outside verifying is ignored
    expect(
      sessionReducer(
        { phase: 'handshaking', role: 'joiner' },
        { type: 'VERIFY', match: true },
      ).phase,
    ).toBe('handshaking');
  });

  it('failed and closed are retryable back to idle', () => {
    expect(sessionReducer({ phase: 'failed', reason: 'x' }, { type: 'RETRY' })).toEqual({
      phase: 'idle',
    });
    expect(sessionReducer({ phase: 'closed', reason: 'x' }, { type: 'RETRY' })).toEqual({
      phase: 'idle',
    });
  });

  it('terminal states ignore live events', () => {
    const failed = { phase: 'failed', reason: 'x' } as SessionState;
    expect(sessionReducer(failed, { type: 'CREATE' })).toBe(failed);
    expect(sessionReducer(failed, { type: 'PEER_LEFT' })).toBe(failed);
  });
});

describe('inviteUrlFor', () => {
  it('appends the join hash to the current origin path', () => {
    const url = inviteUrlFor('x7k2p9');
    expect(url).toContain('#/join/x7k2p9');
  });
});
