import { sessionStore } from '../../instances'
import { verifyBinding } from '../../identity'
import type { OwnBadge } from '../db'
import type { BadgeSlot } from '../badge'
import type { IdentityScope, P2pParts } from './scope'
import { time } from '../../platform/time'
import type { Cancel } from '../../clock'

export const BADGE_NOT_SPREAD =
  'Your renewed badge has not reached your P2P servers. It is sent again with the next renewal. To send it now, turn the badge off and on.'

export function createBadgePart(parts: Pick<P2pParts, 'store' | 'calls'>, scope: IdentityScope) {
  const state = parts.store
  const { useP2p } = state

  // Test hook: `?badge=local` lets this tab check badges issued by an instance on this machine or
  // the local network (only ever the one it runs on), like `?ice=relay` in ice.ts.
  const localBadges = (): boolean => {
    if (typeof window === 'undefined') return false
    try {
      if (new URLSearchParams(window.location.search).get('badge') === 'local')
        sessionStore.setItem('rchat_badge_local', '1')
      return sessionStore.getItem('rchat_badge_local') === '1'
    } catch {
      return false
    }
  }

  const badgeLocal = localBadges()

  // Bindings are accepted only from this client's own instance: P2P across instances isn't
  // supported, and a peer can't make us fetch keys from a host it picks.
  const instanceHost = () => scope.owner.conn.info?.host ?? scope.owner.conn.host

  const checkBinding = (token: string, ik: string) =>
    verifyBinding(token, { ik, host: instanceHost(), allowLocal: badgeLocal })

  // This account as the instance names it in bindings.
  const accountSub = () => {
    const username = useP2p.getState().account
    return username ? `${username}@${instanceHost()}` : null
  }

  let badgeTimer: Cancel | null = null

  let expiryTimer: Cancel | null = null

  // The badges into the view, and again when the next one expires ("Confirmation expired").
  const mirrorBadges = (all: Record<string, BadgeSlot>) => {
    useP2p.setState({ badges: all })
    expiryTimer?.()
    expiryTimer = null
    const now = time().now()
    const next = Math.min(
      ...Object.values(all).flatMap(b => (b.ok && b.ok.exp * 1000 > now ? [b.ok.exp * 1000] : []))
    )
    if (Number.isFinite(next))
      expiryTimer = time().after(Math.min(next - now + 1000, 2 ** 31 - 1), () =>
        mirrorBadges({ ...useP2p.getState().badges })
      )
  }

  const scheduleBadges = () => {
    if (badgeTimer !== null) return
    badgeTimer = time().after(30, () => {
      badgeTimer = null
      if (state.badges) mirrorBadges(state.badges.all())
    })
  }

  // Our own badge changed here: tabs that only read hear it (they re-read it on `badges`).
  const tellBadge = (
    was: OwnBadge | null,
    now: OwnBadge | null,
    post: (m: { badges: true }) => void
  ) => {
    if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) post({ badges: true })
  }

  // ----- Account badge -----

  const p2pBadge = {
    // Turns the badge on once the instance signed a binding; the error says why it didn't.
    async enable() {
      const k = state.keeper
      if (!k) return useP2p.setState({ badgeError: parts.calls.ELSEWHERE_TEXT })
      useP2p.setState({ badgeBusy: true, badgeError: null })
      try {
        await k.enable()
      } catch (e) {
        useP2p.setState({ badgeError: e instanceof Error ? e.message : String(e) })
      } finally {
        useP2p.setState({ badgeBusy: false })
      }
    },
    async disable() {
      const k = state.keeper
      if (!k) return useP2p.setState({ badgeError: parts.calls.ELSEWHERE_TEXT })
      useP2p.setState({ badgeError: null })
      try {
        await k.disable()
      } catch (e) {
        useP2p.setState({ badgeError: e instanceof Error ? e.message : String(e) })
      }
    },
    // Couldn't check: ask the issuer again now.
    recheck: (ik: string) => state.badges?.recheck(ik),
  }

  scope.onReset(() => {
    badgeTimer?.()
    expiryTimer?.()
    badgeTimer = null
    expiryTimer = null
  })
  return { badgeLocal, checkBinding, accountSub, mirrorBadges, scheduleBadges, tellBadge, p2pBadge }
}
