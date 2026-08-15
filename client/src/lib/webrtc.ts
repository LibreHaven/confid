// Thin wrapper around RTCPeerConnection for the Confid session flow.
// Responsibilities: SDP offer/answer exchange, ICE candidate forwarding,
// and DataChannel lifecycle — all signaling I/O stays outside this module.

// ICE_SERVERS is the default public STUN configuration. STUN only discovers
// the public address; no media or message data ever touches these servers.
// STUN list: every entry is verified with a real RFC 5389 binding probe
// (2026-08-15: stun.l.google.com OK, stun1.l.google.com OK,
// stun.miwifi.com OK — mainland China reachability). International first,
// mainland China last. Trickle ICE sends each candidate as it arrives, so
// extra servers cost nothing — they only add candidates.
// Exported so the session layer can merge TURN credentials after them.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Mainland China: google UDP is unreachable from CN mobile networks.
  { urls: 'stun:stun.miwifi.com:3478' },
];

// DATA_CHANNEL_LABEL identifies the message channel within a connection.
export const DATA_CHANNEL_LABEL = 'confid-messages';

// CHANNEL_LOW_THRESHOLD_BYTES fires bufferedamountlow once the sender's
// queue drains below this (file-transfer backpressure). Exported because
// BOTH sides' channels must set it: the joiner's channel arrives via
// ondatachannel with the default threshold of 0, where bufferedamountlow
// never fires while the buffer stays non-empty — a deadlocked transfer.
export const CHANNEL_LOW_THRESHOLD_BYTES = 256 * 1024;

/** Events the session layer consumes from a PeerConnection. */
export interface PeerEvents {
  onChannel(channel: RTCDataChannel): void;
  onIceCandidate(candidate: RTCIceCandidateInit): void;
  onStateChange(state: RTCPeerConnectionState): void;
  onGatheringState?(state: RTCIceGatheringState): void;
}

/**
 * Parses the candidate type from an ICE candidate string ("typ host",
 * "typ srflx", "typ relay", ...). Used for the debug panel so a failed
 * session shows whether NAT discovery even produced candidates.
 */
export function candidateType(candidate: string): 'host' | 'srflx' | 'relay' | 'unknown' {
  const m = / typ (host|srflx|relay)/.exec(candidate);
  if (m) return m[1] as 'host' | 'srflx' | 'relay';
  return 'unknown';
}

/**
 * Creates a peer connection wired to the given events.
 * The caller owns the signaling transport (offer/answer/ICE relay).
 * iceServers defaults to the public STUN list; pass the merge of TURN
 * credentials (fetched at session start) to add relay candidates.
 */
export function createPeerConnection(
  events: PeerEvents,
  iceServers: RTCIceServer[] = ICE_SERVERS,
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      events.onIceCandidate(e.candidate.toJSON());
    }
  };
  if (events.onGatheringState) {
    pc.onicegatheringstatechange = () => {
      events.onGatheringState?.(pc.iceGatheringState);
    };
  }
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
