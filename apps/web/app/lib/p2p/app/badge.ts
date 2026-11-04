import { home } from '../../instances'
import { verifyBinding } from '../../identity'
import type { OwnBadge } from '../db'
import type { BadgeSlot } from '../badge'
import { useP2p, badges, keeper } from './store'
import { ELSEWHERE_TEXT } from './calls'

// Test hook: `?badge=local` lets this tab check badges issued by an instance on this machine or
// the local network (only ever the one it runs on), like `?ice=relay` in ice.ts.
const localBadges = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('badge') === 'local')
      sessionStorage.setItem('rchat_badge_local', '1')
    return sessionStorage.getItem('rchat_badge_local') === '1'
  } catch {
    return false
  }
}

export const badgeLocal = localBadges()

// Bindings are accepted only from this client's own instance: P2P across instances isn't
// supported, and a peer can't make us fetch keys from a host it picks.
const instanceHost = () => home.info?.host ?? home.host

export const checkBinding = (token: string, ik: string) =>
  verifyBinding(token, { ik, host: instanceHost(), allowLocal: badgeLocal })

// This account as the instance names it in bindings.
export const accountSub = () => {
  const username = useP2p.getState().account
  return username ? `${username}@${instanceHost()}` : null
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null

let expiryTimer: ReturnType<typeof setTimeout> | null = null

// The badges into the view, and again when the next one expires ("Confirmation expired").
export const mirrorBadges = (all: Record<string, BadgeSlot>) => {
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

export const scheduleBadges = () => {
  if (badgeTimer !== null) return
  badgeTimer = setTimeout(() => {
    badgeTimer = null
    if (badges) mirrorBadges(badges.all())
  }, 30)
}

// Our own badge changed here: tabs that only read hear it (they re-read it on `badges`).
export const tellBadge = (
  was: OwnBadge | null,
  now: OwnBadge | null,
  post: (m: { badges: true }) => void
) => {
  if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) post({ badges: true })
}

// ----- Account badge -----

export const p2pBadge = {
  // Turns the badge on once the instance signed a binding; the error says why it didn't.
  async enable() {
    const k = keeper
    if (!k) return useP2p.setState({ badgeError: ELSEWHERE_TEXT })
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
    const k = keeper
    if (!k) return useP2p.setState({ badgeError: ELSEWHERE_TEXT })
    useP2p.setState({ badgeError: null })
    try {
      await k.disable()
    } catch (e) {
      useP2p.setState({ badgeError: e instanceof Error ? e.message : String(e) })
    }
  },
  // Couldn't check: ask the issuer again now.
  recheck: (ik: string) => badges?.recheck(ik),
}
