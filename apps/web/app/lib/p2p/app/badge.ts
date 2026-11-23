import { client } from '../../client/client'
import { legacyScope } from './store'
import { sessionStore } from '../../instances'
import { verifyBinding } from '../../identity'
import type { OwnBadge } from '../db'
import type { BadgeSlot } from '../badge'
import * as storePart from './store'
import * as callsPart from './calls'
import type { IdentityScope, P2pParts } from './scope'

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
  const instanceHost = () =>
    (scope.owner ?? client.shown()).conn.info?.host ?? (scope.owner ?? client.shown()).conn.host

  const checkBinding = (token: string, ik: string) =>
    verifyBinding(token, { ik, host: instanceHost(), allowLocal: badgeLocal })

  // This account as the instance names it in bindings.
  const accountSub = () => {
    const username = useP2p.getState().account
    return username ? `${username}@${instanceHost()}` : null
  }

  let badgeTimer: ReturnType<typeof setTimeout> | null = null

  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  // The badges into the view, and again when the next one expires ("Confirmation expired").
  const mirrorBadges = (all: Record<string, BadgeSlot>) => {
    useP2p.setState({ badges: all })
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
    const now = Date.now()
    const next = Math.min(
      ...Object.values(all).flatMap(b => (b.ok && b.ok.exp * 1000 > now ? [b.ok.exp * 1000] : []))
    )
    if (Number.isFinite(next))
      expiryTimer = setTimeout(
        () => mirrorBadges({ ...useP2p.getState().badges }),
        Math.min(next - now + 1000, 2 ** 31 - 1)
      )
  }

  const scheduleBadges = () => {
    if (badgeTimer !== null) return
    badgeTimer = setTimeout(() => {
      badgeTimer = null
      if (state.badges) mirrorBadges(state.badges.all())
    }, 30)
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
    if (badgeTimer !== null) clearTimeout(badgeTimer)
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    badgeTimer = null
    expiryTimer = null
  })
  return { badgeLocal, checkBinding, accountSub, mirrorBadges, scheduleBadges, tellBadge, p2pBadge }
}

export const legacyBadge = createBadgePart(
  {
    store: storePart,
    calls: callsPart,
  },
  legacyScope
)
export const {
  badgeLocal,
  checkBinding,
  accountSub,
  mirrorBadges,
  scheduleBadges,
  tellBadge,
  p2pBadge,
} = legacyBadge
