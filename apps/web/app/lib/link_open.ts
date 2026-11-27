import type { AccountSession } from './client/session'
import { messageInstanceTarget, routeInstanceLink } from './client/instance_links'
import { localOrigins } from './instances'
import { needsWarning, webLink } from './link_safety'

// The page's address, which relative links are read against.
const pageBase = () => (typeof location === 'undefined' ? undefined : location.href)

// Whether opening `href` from a message shows the external link warning first.
export function warnsBefore(acct: AccountSession, href: string, own: boolean) {
  const s = acct.store.getState()
  const publicUrl = s.instance?.public_url ?? acct.conn.info?.public_url ?? null
  return needsWarning(s.linkPrefs, href, localOrigins(acct.conn, publicUrl), own, pageBase())
}

// Opens a message's link: a link to this app goes to its view, an outside one asks first when
// it should, and opens in a new tab.
export function openMessageLink(
  acct: AccountSession,
  href: string,
  label: string | null,
  own: boolean
) {
  const target = messageInstanceTarget(acct, href)
  if (target) return void acct.lifetime.inSession(() => routeInstanceLink(acct, target))()
  if (warnsBefore(acct, href, own)) {
    acct.store.getState().openDialog({ kind: 'external_link', href, label })
    return
  }
  const url = webLink(href, pageBase())
  if (url) window.open(url.href, '_blank', 'noopener,noreferrer')
}
