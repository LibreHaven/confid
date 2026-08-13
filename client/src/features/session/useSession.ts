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
import { initialState, sessionReducer, type SessionEvent } from './sessionMachine';

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

const signalingUrl = () => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
};

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);

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
      const msg = JSON.parse(raw) as { kind: string; data?: string };
      if (msg.kind === 'hello' && crypto.current && !crypto.current.sessionKey) {
        // Peer's public key arrives over the channel; derive and verify.
        const peerKey = await importPublicKey(JSON.parse(msg.data!));
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
      } else if (msg.kind === 'text' && crypto.current?.sessionKey) {
        const data = base64ToBuffer(msg.data!);
        const text = await decryptMessage(crypto.current.sessionKey, data);
        setMessages((prev) => [
          ...prev,
          { id: globalThis.crypto.randomUUID(), text, own: false },
        ]);
      }
    },
    [clearHandshakeTimer, send],
  );

  const onChannel = useCallback(
    (ch: RTCDataChannel) => {
      channel.current = ch;
      ch.onmessage = (e) => {
        void handleChannelMessage(String(e.data));
      };
    },
    [handleChannelMessage],
  );

  const sendHello = useCallback(async () => {
    if (!channel.current || !crypto.current) return;
    const jwk = await exportPublicKey(crypto.current.keyPair.publicKey);
    channel.current.send(JSON.stringify({ kind: 'hello', data: JSON.stringify(jwk) }));
  }, []);

  // --- Signaling protocol ---------------------------------------------------

  const handleSignal = useCallback(
    async (payload: unknown) => {
      const sig = payload as {
        kind: string;
        sdp?: string;
        salt?: string;
        candidate?: unknown;
      };
      switch (sig.kind) {
        case 'offer': {
          pendingSalt.current = sig.salt ?? null;
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
          await addIceCandidate(pc.current!, sig.candidate as RTCIceCandidateInit);
          break;
      }
    },
    [send],
  );

  const connect = useCallback(() => {
    send({ type: 'CONNECTED' });
    // no-op: signaling client is created on first create/join to keep
    // the machine's phases authoritative.
  }, [send]);

  const startSignaling = useCallback(
    (roomId?: string) => {
      const client = new SignalingClient(signalingUrl(), {
        onCreated: (id) => send({ type: 'CREATED', roomId: id }),
        onJoined: () => send({ type: 'JOINED' }),
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

  /** Generates the local key pair and shows its fingerprint. */
  const startPeerSetup = useCallback(async () => {
    const keyPair = await generateKeyPair();
    crypto.current = {
      keyPair,
      sessionKey: null as unknown as CryptoKey,
      remoteFingerprint: '',
    };
    setLocalFingerprint(await fingerprintOf(keyPair.publicKey));
  }, []);

  const createRoom = useCallback(async () => {
    await startPeerSetup();
    startSignaling();
    send({ type: 'CONNECTED' });
    send({ type: 'CREATE' });
  }, [send, startSignaling, startPeerSetup]);

  const joinRoom = useCallback(
    async (roomId: string) => {
      await startPeerSetup();
      startSignaling(roomId);
      send({ type: 'CONNECTED' });
      send({ type: 'JOIN', roomId });
    },
    [send, startSignaling, startPeerSetup],
  );

  // --- WebRTC wiring --------------------------------------------------------

  useEffect(() => {
    if (state.phase === 'handshaking' && pc.current && !channel.current) {
      // Creator side: owns the channel and initiates the offer.
      const offerChannel = createDataChannel(pc.current);
      onChannel(offerChannel);
      offerChannel.onopen = () => void sendHello();
      void createOffer(pc.current!).then((offer) => {
        signaling.current?.sendSignal({
          kind: 'offer',
          sdp: offer.sdp,
          salt: randomSalt(),
        });
      });
      startHandshakeTimer();
    }
  }, [state.phase, onChannel, sendHello, startHandshakeTimer]);

  useEffect(() => {
    if (state.phase === 'ready' && !pc.current) {
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
  }, [state.phase, onChannel, send]);

  useEffect(() => {
    if (state.phase === 'active') {
      clearHandshakeTimer();
    }
    if (state.phase === 'failed' || state.phase === 'closed') {
      clearHandshakeTimer();
      channel.current?.close();
      pc.current?.close();
      channel.current = null;
      pc.current = null;
      crypto.current = null;
      signaling.current?.close();
      signaling.current = null;
    }
  }, [state.phase, clearHandshakeTimer]);

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

  const retry = useCallback(() => send({ type: 'RETRY' }), [send]);

  return {
    state,
    messages,
    localFingerprint,
    actions: { createRoom, joinRoom, sendMessage, verifyFingerprint, retry, connect },
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
