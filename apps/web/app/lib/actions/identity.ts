import { legacyP2pApp, type P2pApp } from '../p2p/app/runtime'
import type { Action } from './types'

import { bindIdentityAction } from './registry'

export function identityActions<T extends { actions: Action[] }>(build: (identity: P2pApp) => T) {
  const bundles = new WeakMap<P2pApp, T>()
  function forIdentity(identity: P2pApp) {
    let bundle = bundles.get(identity)
    if (!bundle) {
      bundle = build(identity)
      bundles.set(identity, bundle)
    }
    return bundle
  }
  const defaults = forIdentity(legacyP2pApp)
  defaults.actions.forEach((action, i) =>
    bindIdentityAction(action, app => forIdentity(app).actions[i])
  )
  return { defaults, forIdentity }
}
