// Empty until the instance advertises relays; PeerJS would otherwise fall
// back to its built-in public STUN/TURN servers.
export const iceServers = (): RTCIceServer[] => []

export const iceConfig = (): RTCConfiguration => ({ iceServers: iceServers() })
