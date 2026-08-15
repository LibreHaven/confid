import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  CHANNEL_LOW_THRESHOLD_BYTES,
  DATA_CHANNEL_LABEL,
  addIceCandidate,
  createAnswer,
  createDataChannel,
  createOffer,
  createPeerConnection,
  setRemoteDescription,
} from './webrtc';

/** Minimal RTCPeerConnection stand-in for wiring assertions. */
class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: RTCDataChannel }) => void) | null = null;
  iceServers: RTCIceServer[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'v=0' }));
  setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
    this.localDescription = d;
  });
  setRemoteDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  createDataChannel = vi.fn((label: string) => ({ label }) as RTCDataChannel);

  constructor(config: RTCConfiguration) {
    this.iceServers = config.iceServers ?? [];
    MockPeerConnection.instances.push(this);
  }
}

beforeEach(() => {
  MockPeerConnection.instances = [];
  vi.stubGlobal(
    'RTCPeerConnection',
    MockPeerConnection as unknown as typeof RTCPeerConnection,
  );
});

describe('createPeerConnection', () => {
  it('is created with a public STUN server', () => {
    createPeerConnection({
      onChannel: vi.fn(),
      onIceCandidate: vi.fn(),
      onStateChange: vi.fn(),
    });
    const pc = MockPeerConnection.instances[0]!;
    expect(pc.iceServers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.miwifi.com:3478' },
    ]);
  });

  it('forwards real ICE candidates and drops null end-of-candidates', () => {
    const onIceCandidate = vi.fn();
    createPeerConnection({
      onChannel: vi.fn(),
      onIceCandidate,
      onStateChange: vi.fn(),
    });
    const pc = MockPeerConnection.instances[0]!;
    const candidate = {
      candidate: 'candidate:1',
      toJSON: () => ({ candidate: 'candidate:1' }),
    } as unknown as RTCIceCandidate;
    pc.onicecandidate!({ candidate });
    pc.onicecandidate!({ candidate: null });
    expect(onIceCandidate).toHaveBeenCalledTimes(1);
    expect(onIceCandidate).toHaveBeenCalledWith({ candidate: 'candidate:1' });
  });

  it('forwards connection state changes', () => {
    const onStateChange = vi.fn();
    createPeerConnection({
      onChannel: vi.fn(),
      onIceCandidate: vi.fn(),
      onStateChange,
    });
    const pc = MockPeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange!();
    expect(onStateChange).toHaveBeenCalledWith('connected');
  });

  it('forwards incoming data channels', () => {
    const onChannel = vi.fn();
    createPeerConnection({
      onChannel,
      onIceCandidate: vi.fn(),
      onStateChange: vi.fn(),
    });
    const pc = MockPeerConnection.instances[0]!;
    const channel = { label: DATA_CHANNEL_LABEL } as RTCDataChannel;
    pc.ondatachannel!({ channel });
    expect(onChannel).toHaveBeenCalledWith(channel);
  });
});

describe('SDP helpers', () => {
  it('createOffer sets local description and returns the offer', async () => {
    const pc = new MockPeerConnection({}) as unknown as RTCPeerConnection;
    const offer = await createOffer(pc);
    expect(offer.type).toBe('offer');
    expect(pc.setLocalDescription).toHaveBeenCalledWith(offer);
  });

  it('createAnswer sets local description and returns the answer', async () => {
    const pc = new MockPeerConnection({}) as unknown as RTCPeerConnection;
    const answer = await createAnswer(pc);
    expect(answer.type).toBe('answer');
    expect(pc.setLocalDescription).toHaveBeenCalledWith(answer);
  });

  it('setRemoteDescription and addIceCandidate delegate', async () => {
    const pc = new MockPeerConnection({}) as unknown as RTCPeerConnection;
    await setRemoteDescription(pc, { type: 'offer', sdp: 'v=0' });
    await addIceCandidate(pc, { candidate: 'candidate:9' });
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:9',
    });
  });

  it('createDataChannel uses the canonical label', () => {
    const pc = new MockPeerConnection({}) as unknown as RTCPeerConnection;
    const ch = createDataChannel(pc);
    expect(pc.createDataChannel).toHaveBeenCalledWith(DATA_CHANNEL_LABEL, {
      ordered: true,
    });
    expect(ch.label).toBe(DATA_CHANNEL_LABEL);
  });

  it('createDataChannel sets the backpressure threshold', () => {
    // Regression: without the threshold, bufferedamountlow never fires on
    // a channel whose buffer stays non-empty → file sends deadlock.
    const pc = new MockPeerConnection({}) as unknown as RTCPeerConnection;
    const ch = createDataChannel(pc);
    expect(ch.bufferedAmountLowThreshold).toBe(CHANNEL_LOW_THRESHOLD_BYTES);
  });
});
