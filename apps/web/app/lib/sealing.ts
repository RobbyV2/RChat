// The state of "Encrypt stored messages" for a hosted server, a hosted DM, a P2P room or a P2P DM:
// one model for every place the switch shows.

export type SealReason = 'forced' | 'keys' | 'updating' | 'permission'

export interface SealState {
  // Whether new content is stored encrypted.
  on: boolean
  // Whether the site requires it, so nobody here can turn it off.
  forced: boolean
  // Whether this person can change it now.
  available: boolean
  reason: SealReason | null
}

// `first_need`: no key yet, and the first switch turned on makes one.
export type SealReadiness = 'ready' | 'first_need' | 'keys' | 'updating'

export interface SealInput {
  // The place's own switch.
  stored: boolean
  forced: boolean
  readiness: SealReadiness
  // Whether this person may change the switch of this place.
  allowed: boolean
}

export function sealState({ stored, forced, readiness, allowed }: SealInput): SealState {
  const on = stored || forced
  if (forced) return { on, forced, available: false, reason: 'forced' }
  if (!allowed) return { on, forced, available: false, reason: 'permission' }
  if (!on && (readiness === 'keys' || readiness === 'updating'))
    return { on, forced, available: false, reason: readiness }
  return { on, forced, available: true, reason: null }
}

const flag = (v: unknown) => v === true || v === 1

const readiness = (v: unknown): SealReadiness =>
  v === 'keys' || v === 'updating' || v === 'first_need' ? v : 'ready'

// What a hosted server or DM says about its switch; absent on a site without the feature.
export interface HostedSeal {
  on?: unknown
  forced?: unknown
  own?: unknown
  server_forced?: unknown
}

// What the site's settings say about encrypted storage; absent until they load.
export interface HostedSite {
  encryption_required?: unknown
  encryption_ready?: unknown
}

// The site-wide requirement comes from the settings when they say it, so a change there shows
// without the place being sent again.
export function hostedServerSeal(
  seal: HostedSeal | null | undefined,
  canManage: boolean,
  site: HostedSite = {}
) {
  const known = seal?.own !== undefined && seal.server_forced !== undefined
  const siteForced = typeof site.encryption_required === 'boolean' ? site.encryption_required : null
  const forced =
    known && siteForced !== null ? flag(seal.server_forced) || siteForced : flag(seal?.forced)
  return sealState({
    stored: known ? flag(seal.own) : flag(seal?.on) && !flag(seal?.forced),
    forced,
    readiness: seal ? readiness(site.encryption_ready) : 'keys',
    allowed: canManage,
  })
}

// Either participant of a hosted DM may switch it.
export const hostedDmSeal = (seal: HostedSeal | null | undefined, site: HostedSite = {}) =>
  hostedServerSeal(seal, true, site)

// The `store {on, earlier?}` register of a P2P room, or the latest `store` content of a P2P DM.
export interface StoreRegister {
  on: boolean
  earlier: boolean
}

export function storeRegister(value: unknown): StoreRegister {
  if (typeof value !== 'object' || value === null) return { on: false, earlier: false }
  const { on, earlier } = value as { on?: unknown; earlier?: unknown }
  return { on: on === true, earlier: on === true && earlier === true }
}

export interface P2pSealInput {
  // The admitted `store` register or DM content, as received.
  store: unknown
  // Whether this identity's site requires encrypted storage.
  siteForced: boolean
  // Whether this device has a device key to seal with.
  deviceKey: boolean
  // An owner or a member with ManageServer in a room; either participant in a DM.
  allowed: boolean
}

export const p2pSeal = ({ store, siteForced, deviceKey, allowed }: P2pSealInput) =>
  sealState({
    stored: storeRegister(store).on,
    forced: siteForced,
    readiness: deviceKey ? 'ready' : 'keys',
    allowed,
  })

export type SealPlace = 'hosted' | 'p2p'

export const SEAL_LABEL = 'Encrypt stored messages'

export const sealDescription = (place: SealPlace) =>
  place === 'hosted'
    ? 'New messages are stored encrypted with a key this site keeps. This is not end-to-end encryption.'
    : "New messages are stored encrypted on each member's device."

// Why the switch can't be changed, as the control shows it under the label.
export function sealReasonText(state: SealState, place: SealPlace): string | null {
  switch (state.reason) {
    case null:
      return null
    case 'forced':
      return 'Required by this site'
    case 'keys':
      return place === 'hosted'
        ? 'This site needs an encryption key first'
        : "This device can't keep an encryption key"
    case 'updating':
      return 'Not available while this site updates'
    case 'permission':
      return null
  }
}

// What stands in for a stored message whose record can't be opened.
export const UNREADABLE_TEXT = "This message can't be opened"

// The confirm that turning the switch on offers, and the earlier messages it may take along.
export const EARLIER_LABEL = 'Also encrypt earlier messages'
export const EARLIER_ACTION = 'Encrypt earlier messages'
export const EARLIER_CONFIRM = 'Earlier messages will be stored only encrypted.'

// The line beside a place whose new messages are stored encrypted, and its lock's label.
export const STORED_ENCRYPTED = 'Stored encrypted'

// What a device key protects where nothing outside the app keeps it.
export const deviceKeyNote = (durable: boolean, shell: boolean) =>
  durable
    ? null
    : shell
      ? "Protects copies of this device's data, not this app's profile"
      : "Protects copies of this device's data, not this browser profile"

// The place of a job over a hosted server's or DM's stored messages.
export const serverPlace = (name: string) => `s:${name}`
export const dmPlace = (id: number) => `d:${id}`

export interface JobView {
  id: number
  direction: 'seal' | 'unseal'
  upto: number
  done: number
  // The message id before the first one of the place the job covers; 0 once it ended.
  from: number
  state: 'running' | 'done' | 'failed'
}

// How far a job got, as a whole percent of the place's messages it covers.
export const jobPercent = ({ upto, done, from, state }: JobView) => {
  if (state === 'done' || upto <= from) return 100
  return Math.max(0, Math.min(99, Math.floor(((done - from) / (upto - from)) * 100)))
}

// A job's state as the settings show it.
export function jobText(job: JobView): string {
  const doing = job.direction === 'seal' ? 'Encrypting earlier messages' : 'Storing messages plain'
  switch (job.state) {
    case 'running':
      return `${doing}: ${jobPercent(job)}%`
    case 'done':
      return job.direction === 'seal'
        ? 'Earlier messages are stored encrypted.'
        : 'Messages are stored plain again.'
    case 'failed':
      return `${doing} stopped. Start it again to go on.`
  }
}

export interface PlacedJob extends JobView {
  place: string
}

const whole = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0)

// One job the API answered; null when it is malformed.
export function jobOf(value: unknown): PlacedJob | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  const { direction, state, upto, done } = o
  if (direction !== 'seal' && direction !== 'unseal') return null
  if (state !== 'running' && state !== 'done' && state !== 'failed') return null
  if (!Number.isSafeInteger(upto) || !Number.isSafeInteger(done)) return null
  const place = typeof o.place === 'string' ? o.place : ''
  return {
    id: whole(o.id),
    place,
    direction,
    upto: upto as number,
    done: done as number,
    from: whole(o.from),
    state,
  }
}

// The newest job of `direction` among a list the API answered (newest first) and one that
// arrived as progress since; null for none.
export function latestJob(
  list: unknown,
  direction: JobView['direction'],
  pushed?: unknown
): PlacedJob | null {
  const listed = Array.isArray(list)
    ? (list.map(jobOf).find(j => j?.direction === direction) ?? null)
    : null
  const arrived = jobOf(pushed)
  if (arrived?.direction !== direction) return listed
  return listed === null || arrived.id >= listed.id ? arrived : listed
}
