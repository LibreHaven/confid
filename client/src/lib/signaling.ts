// WebSocket signaling client + wire protocol codec.
//
// The codec is pure (no WebSocket dependency) so protocol behavior is
// unit-testable; the client is a thin transport wrapper.

/** Wire message shared with the Go signaling server (protocol package). */
export interface SignalingMessage {
  type: string;
  roomId?: string;
  code?: string;
  payload?: unknown;
}

/** Server message types (mirror of signaling/internal/protocol). */
export const MSG_CREATED = 'created';
export const MSG_JOINED = 'joined';
export const MSG_SIGNAL = 'signal';
export const MSG_PEER_LEFT = 'peer_left';
export const MSG_ERROR = 'error';

/** Error codes from the server. */
export const ERR_ROOM_NOT_FOUND = 'room_not_found';
export const ERR_ROOM_FULL = 'room_full';
export const ERR_NOT_IN_ROOM = 'not_in_room';
export const ERR_MALFORMED = 'malformed';

/** Events the session layer consumes from the signaling transport. */
export interface SignalingEvents {
  onCreated(roomId: string): void;
  onJoined(roomId: string): void;
  onSignal(payload: unknown): void;
  onPeerLeft(): void;
  onError(code: string): void;
  onClose(): void;
}

// WS_OPEN mirrors WebSocket.OPEN (1); kept as a local constant because
// jsdom test environments do not provide a global WebSocket.
const WS_OPEN = 1;

/** Serialize an outbound message to the wire format. */
export function encodeSignal(
  type: string,
  opts: { roomId?: string; payload?: unknown } = {},
): string {
  const msg: SignalingMessage = { type };
  if (opts.roomId) {
    msg.roomId = opts.roomId;
  }
  if (opts.payload !== undefined) {
    msg.payload = opts.payload;
  }
  return JSON.stringify(msg);
}

/**
 * Parse an inbound message. Throws on malformed JSON or a missing type.
 */
export function decodeSignal(raw: string): SignalingMessage {
  const msg = JSON.parse(raw) as SignalingMessage;
  if (typeof msg.type !== 'string' || msg.type.length === 0) {
    throw new Error('signal: missing type');
  }
  return msg;
}

/**
 * SignalingClient is a minimal WebSocket transport.
 * The WebSocket constructor is injected for testability.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly events: SignalingEvents,
    private readonly socketFactory: (url: string) => WebSocket = (u) =>
      new WebSocket(u),
  ) {}

  connect(): void {
    const ws = this.socketFactory(this.url);
    this.ws = ws;
    ws.onmessage = (e) => this.handleMessage(String(e.data));
    ws.onclose = () => this.events.onClose();
    ws.onerror = () => ws.close();
  }

  createRoom(): void {
    this.send(encodeSignal('create'));
  }

  joinRoom(roomId: string): void {
    this.send(encodeSignal('join', { roomId }));
  }

  sendSignal(payload: unknown): void {
    this.send(encodeSignal(MSG_SIGNAL, { payload }));
  }

  close(): void {
    this.ws?.close();
  }

  private send(raw: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('signaling: not connected');
    }
    this.ws.send(raw);
  }

  private handleMessage(raw: string): void {
    let msg: SignalingMessage;
    try {
      msg = decodeSignal(raw);
    } catch {
      return; // malformed inbound messages are dropped, not fatal
    }
    switch (msg.type) {
      case MSG_CREATED:
        if (msg.roomId) {
          this.events.onCreated(msg.roomId);
        }
        break;
      case MSG_JOINED:
        if (msg.roomId) {
          this.events.onJoined(msg.roomId);
        }
        break;
      case MSG_SIGNAL:
        this.events.onSignal(msg.payload);
        break;
      case MSG_PEER_LEFT:
        this.events.onPeerLeft();
        break;
      case MSG_ERROR:
        this.events.onError(msg.code ?? 'unknown');
        break;
    }
  }
}
