// Session lifecycle state machine (protocol correctness).
//
// The P2P handshake is a strict protocol: SDP/ICE/key-exchange ordering
// matters, so the lifecycle is modeled as an explicit state machine with
// named states, events, and guards. Reducer is pure — the orchestration
// layer (useSession) maps transport events onto SessionEvents.

/** Protocol lifecycle states (see docs/spec.md conventions). */
export type SessionState =
  | { phase: 'idle' } // initial; nothing connected
  | { phase: 'ready' } // WebSocket connected, no room action yet
  | { phase: 'creating' } // "create" sent, awaiting "created"
  | { phase: 'waiting'; roomId: string; inviteUrl: string } // room open
  | { phase: 'joining'; roomId: string } // "join" sent, awaiting "joined"
  | { phase: 'handshaking'; role: 'creator' | 'joiner' } // SDP/ICE/key exchange; creator owns the offer
  | { phase: 'verifying'; remoteFingerprint: string } // awaiting user check
  | { phase: 'active' } // encrypted channel confirmed
  | { phase: 'failed'; reason: string } // terminal, retryable
  | { phase: 'closed'; reason: string }; // terminal

export type SessionEvent =
  | { type: 'CONNECTED' }
  | { type: 'CREATE' }
  | { type: 'CREATED'; roomId: string }
  | { type: 'JOIN'; roomId: string }
  | { type: 'JOINED' }
  | { type: 'PEER_JOINED' } // other side arrived (creator side)
  | { type: 'OFFER_RECEIVED' } // remote offer handled (joiner side)
  | { type: 'PUBLIC_KEYS_READY'; remoteFingerprint: string }
  | { type: 'VERIFY'; match: boolean } // user compared fingerprints
  | { type: 'PEER_LEFT' }
  | { type: 'ERROR'; code: string }
  | { type: 'TIMEOUT' }
  | { type: 'RETRY' }
  | { type: 'CLOSE' };

export const initialState: SessionState = { phase: 'idle' };

/** Builds the invite URL for a room (hash-based so it works on any host). */
export function inviteUrlFor(roomId: string): string {
  const base = window.location.href.split('#')[0]!;
  return `${base}#/join/${roomId}`;
}

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (state.phase) {
    case 'idle':
      if (event.type === 'CONNECTED') return { phase: 'ready' };
      return state;

    case 'ready':
      if (event.type === 'CREATE') return { phase: 'creating' };
      if (event.type === 'JOIN') return { phase: 'joining', roomId: event.roomId };
      return state;

    case 'creating':
      if (event.type === 'CREATED')
        return {
          phase: 'waiting',
          roomId: event.roomId,
          inviteUrl: inviteUrlFor(event.roomId),
        };
      if (event.type === 'ERROR') return fail(event.code);
      return state;

    case 'waiting':
      if (event.type === 'PEER_JOINED') return { phase: 'handshaking', role: 'creator' };
      if (event.type === 'PEER_LEFT') return closed('peer left');
      if (event.type === 'ERROR') return fail(event.code);
      if (event.type === 'CLOSE') return closed('closed');
      return state;

    case 'joining':
      if (event.type === 'JOINED' || event.type === 'OFFER_RECEIVED')
        return { phase: 'handshaking', role: 'joiner' };
      if (event.type === 'ERROR') return fail(event.code);
      if (event.type === 'PEER_LEFT') return closed('peer left');
      return state;

    case 'handshaking':
      if (event.type === 'PUBLIC_KEYS_READY')
        return { phase: 'verifying', remoteFingerprint: event.remoteFingerprint };
      if (event.type === 'ERROR') return fail(event.code);
      if (event.type === 'TIMEOUT') return fail('handshake timeout');
      if (event.type === 'PEER_LEFT') return closed('peer left');
      return state;

    case 'verifying':
      if (event.type === 'VERIFY' && event.match) return { phase: 'active' };
      if (event.type === 'VERIFY' && !event.match) return fail('fingerprint mismatch');
      if (event.type === 'TIMEOUT') return fail('verification timeout');
      if (event.type === 'PEER_LEFT') return closed('peer left');
      return state;

    case 'active':
      if (event.type === 'PEER_LEFT') return closed('peer left');
      if (event.type === 'ERROR') return fail(event.code);
      if (event.type === 'CLOSE') return closed('closed');
      return state;

    case 'failed':
    case 'closed':
      if (event.type === 'RETRY') return { phase: 'idle' };
      return state;
  }
}

function fail(reason: string): SessionState {
  return { phase: 'failed', reason };
}

function closed(reason: string): SessionState {
  return { phase: 'closed', reason };
}
