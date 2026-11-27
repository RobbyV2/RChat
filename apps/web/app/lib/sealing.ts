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
  readiness?: unknown
}

export const hostedServerSeal = (seal: HostedSeal | null | undefined, canManage: boolean) =>
  sealState({
    stored: flag(seal?.on) && !flag(seal?.forced),
    forced: flag(seal?.forced),
    readiness: seal ? readiness(seal.readiness) : 'keys',
    allowed: canManage,
  })

// Either participant of a hosted DM may switch it.
export const hostedDmSeal = (seal: HostedSeal | null | undefined) => hostedServerSeal(seal, true)

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
