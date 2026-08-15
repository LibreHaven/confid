// Orchestration: wires signaling + WebRTC + crypto onto the session
// state machine. Transport concerns live in src/lib; this hook owns the
// protocol choreography and is deliberately thin (E2E covers it).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  deriveSessionKey,
  decryptMessage,
  encryptMessage,
  exportPublicKey,
  fingerprintOf,
  generateKeyPair,
  importPublicKey,
  randomSalt,
} from '../../lib/crypto';
import { base64ToBuffer, bufferToBase64 } from '../../lib/base64';
import {
  FILE_CHUNK_KIND,
  FILE_META_KIND,
  MAX_FILE_BYTES,
  FileReceiver,
  parseFileMeta,
  splitFile,
  type FileChunk,
} from '../../lib/fileTransfer';
import { SignalingClient } from '../../lib/signaling';
import {
  CHANNEL_LOW_THRESHOLD_BYTES,
  addIceCandidate,
  candidateType,
  createAnswer,
  createDataChannel,
  createOffer,
  createPeerConnection,
  setRemoteDescription,
} from '../../lib/webrtc';
import {
  initialState,
  sessionReducer,
  acceptsSignal,
  type SessionEvent,
  type SignalKind,
} from './sessionMachine';

/** A chat message shown in the UI: plain text or a file transfer. */
export type ChatMessage =
  | { id: string; own: boolean; kind: 'text'; text: string }
  | {
      id: string;
      own: boolean;
      kind: 'file';
      name: string;
      size: number;
      progress: number; // 0..1
      state: 'sending' | 'receiving' | 'complete' | 'failed';
      url?: string; // download link (receiver side, once complete)
    };

/** Crypto context derived during handshaking. */
interface SessionCrypto {
  keyPair: CryptoKeyPair;
  sessionKey: CryptoKey;
  remoteFingerprint: string;
}

// HANDSHAKE_TIMEOUT_MS bounds the SDP/ICE/key exchange phase.
const HANDSHAKE_TIMEOUT_MS = 30_000;

// SESSION_INFO binds the derived key to this application context.
const SESSION_INFO = 'confid/session/v1';

// ROOM_ID_PATTERN matches the server's 6-char deconfused room ids
// (mirror of hub.roomIDAlphabet: 0/O/1/I/l excluded).
const ROOM_ID_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/;

// SEND_BACKPRESSURE_BYTES: the sender pauses while the channel buffer
// holds more than this (file-transfer flow control).
const SEND_BACKPRESSURE_BYTES = 1 * 1024 * 1024;

/**
 * Resolves once the channel buffer drains below the low threshold.
 * Rejects when the channel closes while waiting, so an interrupted
 * transfer fails loudly instead of hanging forever.
 */
function waitForBackpressure(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= SEND_BACKPRESSURE_BYTES) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('channel closed while waiting for backpressure'));
    };
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
    };
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
  });
}

const signalingUrl = () => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
};

/** One structured diagnostic event for the debug panel. */
export interface DebugEvent {
  t: number; // relative milliseconds since session hook mount
  event: string;
  detail?: string;
}

/** ICE candidate tally — answers "did NAT discovery even produce candidates?". */
export interface IceTally {
  host: number;
  srflx: number;
  relay: number;
  unknown: number;
}

/** Diagnostics surfaced to the debug panel (debug mode only). */
export interface SessionDebug {
  events: DebugEvent[];
  ice: IceTally;
  connectionState: string;
  gatheringState: string;
}

const EMPTY_ICE: IceTally = { host: 0, srflx: 0, relay: 0, unknown: 0 };
const MAX_DEBUG_EVENTS = 50;

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);
  const [debug, setDebug] = useState<SessionDebug>({
    events: [],
    ice: EMPTY_ICE,
    connectionState: 'new',
    gatheringState: 'new',
  });
  const debugStart = useRef(performance.now());

  // Records one structured protocol/ICE event (ring buffer, newest last).
  const pushDebug = useCallback((event: string, detail?: string) => {
    setDebug((prev) => ({
      ...prev,
      events: [
        ...prev.events.slice(-(MAX_DEBUG_EVENTS - 1)),
        { t: Math.round(performance.now() - debugStart.current), event, detail },
      ],
    }));
  }, []);

  // Mirrors the latest state for stable callbacks (transport handlers must
  // not be recreated per render, yet need to read the current phase/role).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const signaling = useRef<SignalingClient | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const crypto = useRef<SessionCrypto | null>(null);
  const pendingSalt = useRef<string | null>(null);
  const handshakeTimer = useRef<number | null>(null);
  // In-flight inbound file transfers, keyed by the file id from the meta.
  const receivers = useRef<Map<string, FileReceiver>>(new Map());

  const send = useCallback(
    (event: SessionEvent) => {
      pushDebug(`dispatch:${event.type}`);
      dispatch(event);
    },
    [dispatch, pushDebug],
  );

  const clearHandshakeTimer = useCallback(() => {
    if (handshakeTimer.current !== null) {
      window.clearTimeout(handshakeTimer.current);
      handshakeTimer.current = null;
    }
  }, []);

  const failWithTimeout = useCallback(() => {
    clearHandshakeTimer();
    send({ type: 'TIMEOUT' });
  }, [clearHandshakeTimer, send]);

  const startHandshakeTimer = useCallback(() => {
    clearHandshakeTimer();
    handshakeTimer.current = window.setTimeout(failWithTimeout, HANDSHAKE_TIMEOUT_MS);
  }, [clearHandshakeTimer, failWithTimeout]);

  // --- DataChannel protocol ------------------------------------------------

  const handleChannelMessage = useCallback(
    async (raw: string) => {
      let msg: { kind: string; data?: unknown };
      try {
        msg = JSON.parse(raw) as { kind: string; data?: unknown };
      } catch {
        return; // malformed DataChannel frame: drop, never crash the session
      }
      // file-chunk frames are high-frequency (one per 64KB) and carry no
      // diagnostic value beyond the message-level progress — skip them so
      // the debug ring buffer and re-renders don't grow with transfer size.
      if (msg.kind !== FILE_CHUNK_KIND) {
        pushDebug(`frame:${msg.kind}`);
      }
      if (msg.kind === 'hello' && crypto.current && !crypto.current.sessionKey) {
        try {
          // Peer's public key arrives over the channel; derive and verify.
          const peerKey = await importPublicKey(
            JSON.parse(msg.data as string) as JsonWebKey,
          );
          const salt = new TextEncoder().encode(pendingSalt.current ?? '');
          const sessionKey = await deriveSessionKey(
            crypto.current.keyPair.privateKey,
            peerKey,
            salt,
            SESSION_INFO,
          );
          crypto.current.sessionKey = sessionKey;
          crypto.current.remoteFingerprint = await fingerprintOf(peerKey);
          clearHandshakeTimer();
          send({
            type: 'PUBLIC_KEYS_READY',
            remoteFingerprint: crypto.current.remoteFingerprint,
          });
        } catch {
          // A malformed or wrong-curve public key must fail the handshake,
          // not leave the session stuck in an unhandled promise rejection.
          send({ type: 'ERROR', code: 'bad_peer_key' });
        }
      } else if (msg.kind === 'text' && crypto.current?.sessionKey) {
        try {
          const data = base64ToBuffer(msg.data as string);
          const text = await decryptMessage(crypto.current.sessionKey, data);
          setMessages((prev) => [
            ...prev,
            { id: globalThis.crypto.randomUUID(), kind: 'text', text, own: false },
          ]);
        } catch {
          // Tampered or undecryptable message: drop it silently (AES-GCM
          // authentication already failed server-side of this call).
        }
      } else if (msg.kind === FILE_META_KIND && crypto.current?.sessionKey) {
        const meta = parseFileMeta(msg.data);
        if (!meta) {
          // Malformed or oversized declaration: refuse the transfer.
          send({ type: 'ERROR', code: 'bad_file_meta' });
          return;
        }
        receivers.current.set(meta.id, new FileReceiver(meta));
        setMessages((prev) => [
          ...prev,
          {
            id: meta.id,
            kind: 'file',
            name: meta.name,
            size: meta.size,
            progress: 0,
            state: 'receiving',
            own: false,
          },
        ]);
      } else if (msg.kind === FILE_CHUNK_KIND && crypto.current?.sessionKey) {
        const chunk = msg.data as FileChunk;
        const receiver = receivers.current.get(chunk.id);
        if (!receiver) return;
        try {
          const { complete } = receiver.addChunk(chunk);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === chunk.id && m.kind === 'file'
                ? {
                    ...m,
                    progress: receiver.progress,
                    state: complete ? 'complete' : 'receiving',
                    url: complete ? URL.createObjectURL(receiver.toBlob()) : m.url,
                  }
                : m,
            ),
          );
          if (complete) receivers.current.delete(chunk.id);
        } catch {
          // Protocol corruption (wrong id, out of order, over-declared):
          // abort the transfer and surface it as failed.
          receivers.current.delete(chunk.id);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === chunk.id && m.kind === 'file'
                ? { ...m, state: 'failed' as const }
                : m,
            ),
          );
        }
      }
    },
    [clearHandshakeTimer, pushDebug, send],
  );

  const sendHello = useCallback(async () => {
    if (!channel.current || !crypto.current) {
      return;
    }
    pushDebug('hello:send');
    const jwk = await exportPublicKey(crypto.current.keyPair.publicKey);
    channel.current.send(JSON.stringify({ kind: 'hello', data: JSON.stringify(jwk) }));
  }, [pushDebug]);

  const onChannel = useCallback(
    (ch: RTCDataChannel) => {
      channel.current = ch;
      // Both sides must set the backpressure threshold: the creator's
      // channel sets it in createDataChannel, but the joiner's channel
      // (received via ondatachannel) defaults to 0 — without this, its
      // file sends deadlock on the bufferedamountlow wait.
      ch.bufferedAmountLowThreshold = CHANNEL_LOW_THRESHOLD_BYTES;
      ch.onopen = () => {
        pushDebug('channel:open');
        void sendHello();
      };
      ch.onmessage = (e) => {
        void handleChannelMessage(String(e.data));
      };
    },
    [handleChannelMessage, pushDebug, sendHello],
  );

  // --- Signaling protocol ---------------------------------------------------

  const handleSignal = useCallback(
    async (payload: unknown) => {
      const sig = payload as {
        kind: string;
        sdp?: string;
        salt?: string;
        candidate?: unknown;
      };
      // Role guard (protocol layer): only accept the SDP kinds this side
      // may legally process. A malicious peer driving our WebRTC stack
      // (e.g. an offer racing the creator's own offer) must not corrupt
      // the SDP state machine.
      if (!acceptsSignal(stateRef.current, sig.kind as SignalKind)) {
        return;
      }
      switch (sig.kind) {
        case 'offer': {
          if (typeof sig.salt !== 'string') {
            // The salt is a shared HKDF parameter: without it the derived
            // keys would diverge. Fail loudly instead of negotiating a
            // broken session.
            send({ type: 'ERROR', code: 'missing_salt' });
            return;
          }
          pendingSalt.current = sig.salt;
          await setRemoteDescription(pc.current!, {
            type: 'offer',
            sdp: sig.sdp!,
          });
          const answer = await createAnswer(pc.current!);
          send({ type: 'OFFER_RECEIVED' });
          signaling.current?.sendSignal({ kind: 'answer', sdp: answer.sdp });
          break;
        }
        case 'answer':
          await setRemoteDescription(pc.current!, {
            type: 'answer',
            sdp: sig.sdp!,
          });
          break;
        case 'ice':
          try {
            await addIceCandidate(pc.current!, sig.candidate as RTCIceCandidateInit);
          } catch {
            // Invalid/stale candidate: ignore. Late candidates for a
            // closed connection are normal during trickle ICE teardown.
          }
          break;
      }
    },
    [send],
  );

  const startSignaling = useCallback(
    (roomId?: string) => {
      const client = new SignalingClient(signalingUrl(), {
        onCreated: (id) => send({ type: 'CREATED', roomId: id }),
        onJoined: () => send({ type: 'JOINED' }),
        onPeerJoined: () => send({ type: 'PEER_JOINED' }),
        onSignal: (p) => void handleSignal(p),
        onPeerLeft: () => send({ type: 'PEER_LEFT' }),
        onError: (code) => send({ type: 'ERROR', code }),
        onClose: () => send({ type: 'ERROR', code: 'connection_lost' }),
      });
      signaling.current = client;
      client.connect();
      if (roomId) {
        client.joinRoom(roomId);
      } else {
        client.createRoom();
      }
    },
    [handleSignal, send],
  );

  /** Generates the local key pair, shows its fingerprint, and prepares WebRTC. */
  const startPeerSetup = useCallback(async () => {
    const keyPair = await generateKeyPair();
    crypto.current = {
      keyPair,
      sessionKey: null as unknown as CryptoKey,
      remoteFingerprint: '',
    };
    setLocalFingerprint(await fingerprintOf(keyPair.publicKey));
    if (!pc.current) {
      // Created here, not in an effect: the idle→creating dispatch batch
      // skips the intermediate 'ready' render, so an effect on 'ready'
      // would never run.
      pc.current = createPeerConnection({
        onChannel,
        onIceCandidate: (candidate) => {
          const type = candidateType(candidate.candidate ?? '');
          pushDebug(`candidate:${type}`, candidate.candidate);
          setDebug((prev) => ({
            ...prev,
            ice: { ...prev.ice, [type]: prev.ice[type] + 1 },
          }));
          signaling.current?.sendSignal({ kind: 'ice', candidate });
        },
        onStateChange: (connState) => {
          setDebug((prev) => ({ ...prev, connectionState: connState }));
          pushDebug(`ice_state:${connState}`);
          if (connState === 'disconnected' || connState === 'failed') {
            send({ type: 'ERROR', code: `peer_${connState}` });
          }
        },
        onGatheringState: (gatheringState) => {
          setDebug((prev) => ({ ...prev, gatheringState }));
          pushDebug(`gathering:${gatheringState}`);
        },
      });
    }
  }, [onChannel, send]);

  const createRoom = useCallback(async () => {
    await startPeerSetup();
    startSignaling();
    send({ type: 'CONNECTED' });
    send({ type: 'CREATE' });
  }, [send, startSignaling, startPeerSetup]);

  const joinRoom = useCallback(
    async (roomId: string) => {
      // Boundary validation: rooms are 6 chars from the deconfused alphabet.
      // Reject anything else locally instead of firing a doomed join.
      if (!ROOM_ID_PATTERN.test(roomId)) {
        send({ type: 'ERROR', code: 'bad_room_id' });
        return;
      }
      await startPeerSetup();
      startSignaling(roomId);
      send({ type: 'CONNECTED' });
      send({ type: 'JOIN', roomId });
    },
    [send, startSignaling, startPeerSetup],
  );

  // --- WebRTC wiring --------------------------------------------------------

  // Extracted for the effect below: the phase union narrows in the render
  // body, so the dependency array stays type-safe.
  const phase = state.phase;
  const role = state.phase === 'handshaking' ? state.role : null;

  useEffect(() => {
    if (phase === 'handshaking' && role === 'creator' && pc.current && !channel.current) {
      // Creator side: owns the channel and initiates the offer.
      // Channel open/sendHello is handled inside onChannel for both sides.
      const offerChannel = createDataChannel(pc.current);
      onChannel(offerChannel); // sets onopen → sendHello + onmessage
      void createOffer(pc.current!).then(
        (offer) => {
          // The salt must be stored locally AND sent with the offer: both
          // peers derive the session key from the same salt.
          const salt = randomSalt();
          pendingSalt.current = salt;
          signaling.current?.sendSignal({
            kind: 'offer',
            sdp: offer.sdp,
            salt,
          });
        },
        () => send({ type: 'ERROR', code: 'offer_failed' }),
      );
      startHandshakeTimer();
    }
  }, [phase, role, onChannel, send, startHandshakeTimer]);

  // Full teardown of transport + crypto state. Idempotent: called from the
  // terminal-state effect AND directly by retry (cancelling a waiting room
  // never passes through failed/closed, but must still release everything).
  const teardown = useCallback(() => {
    clearHandshakeTimer();
    channel.current?.close();
    pc.current?.close();
    channel.current = null;
    pc.current = null;
    crypto.current = null;
    pendingSalt.current = null;
    signaling.current?.close();
    signaling.current = null;
    receivers.current.clear();
    // Zero-retention: a retry (or a new session in this tab) must not
    // resurrect messages or fingerprints from the finished session.
    setMessages((prev) => {
      for (const m of prev) {
        if (m.kind === 'file' && m.url) URL.revokeObjectURL(m.url);
      }
      return [];
    });
    setLocalFingerprint(null);
  }, [clearHandshakeTimer]);

  useEffect(() => {
    if (state.phase === 'active') {
      clearHandshakeTimer();
    }
    if (state.phase === 'failed' || state.phase === 'closed') {
      teardown();
    }
  }, [state.phase, clearHandshakeTimer, teardown]);

  // --- User actions ---------------------------------------------------------

  const verifyFingerprint = useCallback(
    (match: boolean) => send({ type: 'VERIFY', match }),
    [send],
  );

  const sendMessage = useCallback(async (text: string) => {
    if (!channel.current || !crypto.current?.sessionKey) return;
    const cipher = await encryptMessage(crypto.current.sessionKey, text);
    channel.current.send(JSON.stringify({ kind: 'text', data: bufferToBase64(cipher) }));
    setMessages((prev) => [
      ...prev,
      { id: globalThis.crypto.randomUUID(), kind: 'text', text, own: true },
    ]);
  }, []);

  /**
   * Sends a file over the DataChannel: meta frame, then ordered chunks with
   * backpressure (pause while the channel buffer is full so a slow peer
   * cannot balloon this side's memory). Files never touch the signaling
   * server — the zero-retention invariant is unaffected.
   */
  const sendFile = useCallback(async (file: File): Promise<boolean> => {
    if (!channel.current || !crypto.current?.sessionKey) return false;
    if (file.size > MAX_FILE_BYTES) return false; // UI shows the reason
    const id = globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { meta, chunks } = splitFile(
      id,
      file.name,
      file.type || 'application/octet-stream',
      bytes,
    );
    setMessages((prev) => [
      ...prev,
      {
        id,
        kind: 'file',
        name: file.name,
        size: file.size,
        progress: 0,
        state: 'sending',
        own: true,
      },
    ]);
    const ch = channel.current;
    try {
      ch.send(JSON.stringify({ kind: FILE_META_KIND, data: meta }));
      for (let i = 0; i < chunks.length; i++) {
        await waitForBackpressure(ch); // rejects when the peer disconnects
        ch.send(JSON.stringify({ kind: FILE_CHUNK_KIND, data: chunks[i] }));
        const progress = (i + 1) / chunks.length;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, progress } : m)));
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, state: 'complete', progress: 1 } : m)),
      );
      return true;
    } catch {
      // Peer disconnected mid-transfer (channel send throws, or the
      // backpressure wait rejects): surface the failure instead of an
      // unhandled rejection.
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, state: 'failed' as const } : m)),
      );
      return false;
    }
  }, []);

  const retry = useCallback(() => {
    // Teardown first: cancelling from a waiting room (or any state) must
    // release transports even though the state machine skips failed/closed.
    teardown();
    send({ type: 'RETRY' });
  }, [send, teardown]);

  return {
    state,
    messages,
    localFingerprint,
    debug,
    actions: { createRoom, joinRoom, sendMessage, sendFile, verifyFingerprint, retry },
  };
}
