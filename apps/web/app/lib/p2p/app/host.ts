import type { P2pApp } from './runtime'
import type { AccountSession } from '../../client/session'
import { client } from '../../client/client'
import { EMPTY_NOTIFY } from '../../notify'

// The account's main identity keeps the keys used by the existing chat and notice UI.
export const identityScopeKey = (localId: string, scope: string) =>
  localId === 'main' ? scope : `identity/${localId}/${scope}`

export function bindP2pHost(app: P2pApp, account: AccountSession, live: () => boolean) {
  const localId = app.localId
  const state = account.store.getState
  const scopeKey = (key: string) => identityScopeKey(localId, key)
  const host = app.p2pHost
  host.account = account
  host.prefs = () => (live() ? state().notifyPrefs : EMPTY_NOTIFY)
  host.typingOn = () => live() && state().typingOn
  host.following = scope =>
    live() && client.shown() === account && state().atBottom[scopeKey(scope)] === true
  host.textOnly = () => {
    if (!live()) return true
    const settings = state().settings
    return !settings.asset_uploads && !settings.p2p_attachments
  }
  host.toast = (text, name) => {
    if (live()) state().showToast(text, name)
  }
  host.alert = alert => {
    if (live())
      state().alertFrom({
        ...alert,
        key: scopeKey(alert.key),
        go: account.lifetime.inSession(() => {
          if (live()) alert.go()
        }),
      })
  }
}
