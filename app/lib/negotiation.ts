// Pure pieces of the WebRTC "perfect negotiation" used by rtc.ts.

export interface SignalScope {
  channelId?: number | null
  dmId?: number | null
}

// A signal belongs to the session it was sent for. Ones tagged with another
// channel or call (sent before a switch, still in flight) must not touch the
// peer connections of the current session.
export function sameScope(target: SignalScope | null, sig: SignalScope): boolean {
  if (!target) return false
  return (
    (target.channelId ?? null) === (sig.channelId ?? null) &&
    (target.dmId ?? null) === (sig.dmId ?? null)
  )
}

export interface NegotiationState {
  polite: boolean
  makingOffer: boolean
  negotiated: boolean
  signalingState: RTCSignalingState
}

// What to do with an incoming description. The impolite side ignores an offer that collides
// with its own. The polite side applies it with implicit rollback. The impolite side makes the
// first offer, so until that negotiation is done, each offer it gets collides. An answer is
// valid only while our offer is pending. All else is a stale duplicate.
export function descriptionAction(
  type: RTCSdpType,
  s: NegotiationState
): 'apply' | 'ignore' | 'stale' {
  if (type === 'answer' || type === 'pranswer')
    return s.signalingState === 'have-local-offer' ? 'apply' : 'stale'
  if (type !== 'offer') return 'stale'
  const collision = s.makingOffer || s.signalingState !== 'stable' || !s.negotiated
  return collision && !s.polite ? 'ignore' : 'apply'
}

// Only the impolite side makes the first offer on a new connection. If both sides offer at once
// (two users meet in a room through the same voice_state), the polite side must roll back. Then
// Chromium can leave that side without ICE candidates: both sides stay "stable" with ICE "new"
// and never connect. So the polite side never offers before the first negotiation. If it does
// not connect in time, it asks the impolite side to restart.
export function mayOffer(polite: boolean, negotiated: boolean): boolean {
  return !polite || negotiated
}

// A peer that isn't connected this long after it was created (or after the
// last recovery attempt) is recovered: the impolite side re-offers with an
// ICE restart, the polite side asks it to.
export const CONNECT_TIMEOUT_MS = 5000
// How long a connection may sit in "disconnected" or "failed" before that.
export const RECOVER_GRACE_MS = 2000
// Restart requests that arrive this soon after our last offer are dropped,
// since that offer is still on its way.
export const RESTART_DEBOUNCE_MS = 2000

// Every join or call gets a fresh random session id per side. Signals carry
// the sender's id (sid) and, once known, the id of the session they are for
// (rsid).
export function newSid(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// What we know about the remote session of a peer: undefined until it has
// signalled, null for a legacy client that sends no session id.
export type RemoteSid = string | null | undefined

// A signal from a retired session is dropped, one from a session other than
// the peer's current one means the remote side was replaced (a reload, or a
// quick switch away and back), so the peer connection is replaced too.
export function sidAction(
  known: RemoteSid,
  sid: string | undefined,
  retired: boolean
): 'accept' | 'drop' | 'replace' {
  if (sid !== undefined && retired) return 'drop'
  if (known === undefined || known === (sid ?? null)) return 'accept'
  return 'replace'
}

// Transceivers in the m-line order of a first offer. The screen audio slot is first and has no
// stream id. A legacy receiver plays the first audio track of the stream, so it still picks the
// mic.
export const SLOTS = ['screenAudio', 'mic', 'cam', 'screen'] as const
export type Slot = (typeof SLOTS)[number]
export const SLOT_KIND: Record<Slot, 'audio' | 'video'> = {
  screenAudio: 'audio',
  mic: 'audio',
  cam: 'video',
  screen: 'video',
}

// What goes out on the camera and screen slots. A legacy (0.2.0) peer shows only the camera
// slot. While the camera is off, it gets the screen there. It never gets the screen slot,
// because it cannot show it.
export const videoPlan = <T>(
  cam: T | null,
  screen: T | null,
  legacy: boolean
): { cam: T | null; screen: T | null } => ({
  cam: cam ?? (legacy ? screen : null),
  screen: legacy ? null : screen,
})

// Which transceiver (by index) carries each slot. A connection negotiated
// with the full layout uses it by position; a legacy one (a single audio and
// at most one video, added as tracks) is read by kind order.
export function slotLayout(
  kinds: readonly string[],
  legacy: boolean
): Partial<Record<Slot, number>> {
  const out: Partial<Record<Slot, number>> = {}
  if (!legacy && SLOTS.every((slot, i) => kinds[i] === SLOT_KIND[slot])) {
    SLOTS.forEach((slot, i) => (out[slot] = i))
    return out
  }
  const order: Record<'audio' | 'video', Slot[]> = {
    audio: ['mic', 'screenAudio'],
    video: ['cam', 'screen'],
  }
  kinds.forEach((kind, i) => {
    const slot = kind === 'audio' || kind === 'video' ? order[kind].shift() : undefined
    if (slot) out[slot] = i
  })
  return out
}

// ICE candidates that arrive before the remote description they belong to
// are held until it is set; candidates for an offer we ignored are dropped.
export class CandidateQueue<T> {
  private held: T[] = []

  accept(candidate: T, s: { hasRemote: boolean; ignoring: boolean }): 'add' | 'hold' | 'drop' {
    if (s.hasRemote) return 'add'
    if (s.ignoring) return 'drop'
    this.held.push(candidate)
    return 'hold'
  }

  drain(): T[] {
    const out = this.held
    this.held = []
    return out
  }

  get size(): number {
    return this.held.length
  }
}

// Runs async steps one at a time, in order. Negotiation steps for a peer
// (our offers, incoming descriptions and candidates) go through one of these
// so an incoming offer is never applied while our own setLocalDescription is
// still in flight.
export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.tail.then(step)
    this.tail = next.catch(() => {})
    return next
  }
}

// Tells if a voice_state for a room shows our latest join or leave. Each of our voice ops changes
// our room membership at most once in the server log (a join also removes us from our previous
// room). So a state is current when all our membership changes have shown up. Earlier states
// are stale. Example: after A -> B -> A, the state from the first join to A comes before the
// state that removes us for B.
export class JoinTracker {
  private rooms = new Map<number, { want: boolean; listed: boolean; pending: number }>()
  private last: [number, boolean][] = []

  private expect(id: number, want: boolean, listed = false) {
    let r = this.rooms.get(id)
    if (!r) {
      r = { want: listed, listed, pending: 0 }
      this.rooms.set(id, r)
    }
    if (r.want === want) return
    this.last.push([id, r.want])
    r.want = want
    r.pending += 1
  }

  // We sent a voice_join. `listed` tells if the latest state for the room lists us. If it does,
  // the server still holds a slot for us (another tab, or a reload with the old socket still
  // open). The join takes that slot without a new listing.
  joined(room: number, listed: boolean) {
    this.last = []
    for (const id of this.rooms.keys()) if (id !== room) this.expect(id, false)
    this.expect(room, true, listed)
  }

  left() {
    this.last = []
    for (const id of this.rooms.keys()) this.expect(id, false)
  }

  // The server refused our last join (full room), so none of its changes will show up. For other
  // errors, the changes still arrive and apply as usual.
  refused() {
    for (const [id, want] of this.last) {
      const r = this.rooms.get(id)
      if (r && r.pending > 0) {
        r.pending -= 1
        r.want = want
      }
    }
    this.last = []
  }

  state(room: number, listed: boolean): 'listed' | 'stale' | 'absent' {
    const r = this.rooms.get(room)
    if (!r) return listed ? 'listed' : 'absent'
    if (listed !== r.listed && r.pending > 0) r.pending -= 1
    r.listed = listed
    if (r.pending > 0) return 'stale'
    r.want = listed
    return listed ? 'listed' : 'absent'
  }

  reset() {
    this.rooms.clear()
    this.last = []
  }
}

// What a peer tells us about its media in the small status signal. Fields a
// signal leaves out keep their last value; old clients never send screen.
export interface MediaStatus {
  muted?: boolean
  cam?: boolean
  screen?: boolean
}

export function statusOf(payload: MediaStatus): MediaStatus | null {
  const out: MediaStatus = {}
  if (payload.muted !== undefined) out.muted = payload.muted
  if (payload.cam !== undefined) out.cam = payload.cam
  if (payload.screen !== undefined) out.screen = payload.screen
  return Object.keys(out).length ? out : null
}

export const mergeStatus = (prev: MediaStatus, payload: MediaStatus): MediaStatus => ({
  ...prev,
  ...statusOf(payload),
})
