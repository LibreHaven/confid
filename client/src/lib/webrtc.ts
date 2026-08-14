// Thin wrapper around RTCPeerConnection for the Confid session flow.
// Responsibilities: SDP offer/answer exchange, ICE candidate forwarding,
// and DataChannel lifecycle — all signaling I/O stays outside this module.

// ICE_SERVERS is the public STUN configuration. STUN only discovers the
// public address; no media or message data ever touches these servers.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// DATA_CHANNEL_LABEL identifies the message channel within a connection.
export const DATA_CHANNEL_LABEL = 'confid-messages';

// CHANNEL_LOW_THRESHOLD_BYTES fires bufferedamountlow once the sender's
// queue drains below this (file-transfer backpressure).
const CHANNEL_LOW_THRESHOLD_BYTES = 256 * 1024;

/** Events the session layer consumes from a PeerConnection. */
export interface PeerEvents {
  onChannel(channel: RTCDataChannel): void;
  onIceCandidate(candidate: RTCIceCandidateInit): void;
  onStateChange(state: RTCPeerConnectionState): void;
}

/**
 * Creates a peer connection wired to the given events.
 * The caller owns the signaling transport (offer/answer/ICE relay).
 */
export function createPeerConnection(events: PeerEvents): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      events.onIceCandidate(e.candidate.toJSON());
    }
  };
  pc.onconnectionstatechange = () => events.onStateChange(pc.connectionState);
  pc.ondatachannel = (e) => events.onChannel(e.channel);
  return pc;
}

/** Opens a data channel on a fresh peer connection (the offerer side). */
export function createDataChannel(pc: RTCPeerConnection): RTCDataChannel {
  const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
    ordered: true,
  });
  channel.bufferedAmountLowThreshold = CHANNEL_LOW_THRESHOLD_BYTES;
  return channel;
}

/** Produces an SDP offer. The returned description travels over signaling. */
export async function createOffer(
  pc: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

/** Produces an SDP answer in response to a remote offer. */
export async function createAnswer(
  pc: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

/** Applies a remote offer or answer received over signaling. */
export async function setRemoteDescription(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit,
): Promise<void> {
  await pc.setRemoteDescription(description);
}

/** Feeds an ICE candidate received over signaling. */
export async function addIceCandidate(
  pc: RTCPeerConnection,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  await pc.addIceCandidate(candidate);
}
