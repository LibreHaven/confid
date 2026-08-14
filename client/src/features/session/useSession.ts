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
import { SignalingClient } from '../../lib/signaling';
import {
  addIceCandidate,
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

/** A chat message shown in the UI. */
export interface ChatMessage {
  id: string;
  text: string;
  own: boolean;
}

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

const signalingUrl = () => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
};

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);

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

  const send = useCallback((event: SessionEvent) => dispatch(event), []);

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
      let msg: { kind: string; data?: string };
      try {
        msg = JSON.parse(raw) as { kind: string; data?: string };
      } catch {
        return; // malformed DataChannel frame: drop, never crash the session
      }
      if (msg.kind === 'hello' && crypto.current && !crypto.current.sessionKey) {
        try {
          // Peer's public key arrives over the channel; derive and verify.
          const peerKey = await importPublicKey(JSON.parse(msg.data ?? '') as JsonWebKey);
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
          const data = base64ToBuffer(msg.data ?? '');
          const text = await decryptMessage(crypto.current.sessionKey, data);
          setMessages((prev) => [
            ...prev,
            { id: globalThis.crypto.randomUUID(), text, own: false },
          ]);
        } catch {
          // Tampered or undecryptable message: drop it silently (AES-GCM
          // authentication already failed server-side of this call).
        }
      }
    },
    [clearHandshakeTimer, send],
  );

  const sendHello = useCallback(async () => {
    if (!channel.current || !crypto.current) {
      return;
    }
    const jwk = await exportPublicKey(crypto.current.keyPair.publicKey);
    channel.current.send(JSON.stringify({ kind: 'hello', data: JSON.stringify(jwk) }));
  }, []);

  const onChannel = useCallback(
    (ch: RTCDataChannel) => {
      channel.current = ch;
      ch.onopen = () => void sendHello();
      ch.onmessage = (e) => {
        void handleChannelMessage(String(e.data));
      };
    },
    [handleChannelMessage, sendHello],
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
        onIceCandidate: (candidate) =>
          signaling.current?.sendSignal({ kind: 'ice', candidate }),
        onStateChange: (connState) => {
          if (connState === 'disconnected' || connState === 'failed') {
            send({ type: 'ERROR', code: `peer_${connState}` });
          }
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
    // Zero-retention: a retry (or a new session in this tab) must not
    // resurrect messages or fingerprints from the finished session.
    setMessages([]);
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
      { id: globalThis.crypto.randomUUID(), text, own: true },
    ]);
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
    actions: { createRoom, joinRoom, sendMessage, verifyFingerprint, retry },
  };
}

// --- binary <-> base64 helpers (DataChannel is text-friendly) ---------------

function bufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
