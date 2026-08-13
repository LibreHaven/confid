import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  ERR_ROOM_FULL,
  ERR_ROOM_NOT_FOUND,
  MSG_CREATED,
  MSG_JOINED,
  MSG_PEER_LEFT,
  MSG_SIGNAL,
  SignalingClient,
  decodeSignal,
  encodeSignal,
} from './signaling';

describe('codec', () => {
  it('round-trips a signal with payload', () => {
    const raw = encodeSignal(MSG_SIGNAL, {
      payload: { kind: 'offer', sdp: 'v=0' },
    });
    const msg = decodeSignal(raw);
    expect(msg.type).toBe(MSG_SIGNAL);
    expect(msg.payload).toEqual({ kind: 'offer', sdp: 'v=0' });
  });

  it('encodes roomId for join', () => {
    const msg = decodeSignal(encodeSignal('join', { roomId: 'abc123' }));
    expect(msg.roomId).toBe('abc123');
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeSignal('{not json')).toThrow();
  });

  it('rejects missing type', () => {
    expect(() => decodeSignal('{"roomId":"x"}')).toThrow();
  });
});

/** Fake WebSocket capturing outbound sends and letting tests push messages. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn((raw: string) => {
    this.sent.push(raw);
  });
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  receive(raw: string) {
    this.onmessage?.({ data: raw });
  }
}

function makeClient() {
  const events = {
    onCreated: vi.fn(),
    onJoined: vi.fn(),
    onSignal: vi.fn(),
    onPeerLeft: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const client = new SignalingClient(
    'ws://localhost',
    events,
    (u) => new FakeWebSocket(u) as unknown as WebSocket,
  );
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  return { client, ws, events };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe('SignalingClient', () => {
  it('sends create and forwards created', () => {
    const { client, ws, events } = makeClient();
    client.createRoom();
    expect(ws.sent[0]).toBe('{"type":"create"}');
    ws.receive('{"type":"created","roomId":"x7k2p9"}');
    expect(events.onCreated).toHaveBeenCalledWith('x7k2p9');
  });

  it('sends join with roomId', () => {
    const { client, ws } = makeClient();
    client.joinRoom('abc123');
    expect(ws.sent[0]).toBe('{"type":"join","roomId":"abc123"}');
  });

  it('relays signal payloads and forwards inbound signals', () => {
    const { client, ws, events } = makeClient();
    client.sendSignal({ kind: 'ice', candidate: 'cand:1' });
    expect(ws.sent[0]).toBe(
      '{"type":"signal","payload":{"kind":"ice","candidate":"cand:1"}}',
    );
    ws.receive('{"type":"signal","payload":{"kind":"answer"}}');
    expect(events.onSignal).toHaveBeenCalledWith({ kind: 'answer' });
  });

  it('forwards peer_left and error codes', () => {
    const { client, ws, events } = makeClient();
    ws.receive('{"type":"peer_left"}');
    expect(events.onPeerLeft).toHaveBeenCalled();
    ws.receive('{"type":"error","code":"room_full"}');
    expect(events.onError).toHaveBeenCalledWith(ERR_ROOM_FULL);
    ws.receive('{"type":"error","code":"room_not_found"}');
    expect(events.onError).toHaveBeenCalledWith(ERR_ROOM_NOT_FOUND);
  });

  it('drops malformed inbound messages without crashing', () => {
    const { ws, events } = makeClient();
    ws.receive('{broken');
    ws.receive('{"type":"created"}'); // created without roomId is dropped
    expect(events.onCreated).not.toHaveBeenCalled();
  });

  it('forwards close and refuses sends after close', () => {
    const { client, ws, events } = makeClient();
    ws.close();
    expect(events.onClose).toHaveBeenCalled();
    expect(() => client.createRoom()).toThrow('not connected');
  });

  it('joined is forwarded with roomId', () => {
    const { client, ws, events } = makeClient();
    client.joinRoom('zzz999');
    ws.receive('{"type":"joined","roomId":"zzz999"}');
    expect(events.onJoined).toHaveBeenCalledWith('zzz999');
  });
});
