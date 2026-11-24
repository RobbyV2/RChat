'use client'

import { useState, useSyncExternalStore } from 'react'
import { watchHostedPolicy } from '../../lib/client/hosted_policy'
import { client } from '../../lib/client/client'
import { AccountProvider, useAccount } from '../../lib/client/react'
import { P2pProvider } from '../../lib/client/p2p_react'
import type { PeerLinkRequest } from '../../lib/client/peer_links'
import { AddContactDialog } from './add_contact'
import { ServerNewDialog } from './p2p_invite_dialog'
import { Dialog, textBtn, Masked } from '../ui'

export function PeerCodeDialog({ request }: { request: PeerLinkRequest }) {
  const owner = useAccount()
  const { sessions, link, choices } = request
  const [chosen, choose] = useState(request.selected)
  const mask = () => choices.map(a => (request.valid(a) ? '1' : '0')).join('')
  const available = useSyncExternalStore(
    fn => {
      const off = [
        watchHostedPolicy(fn),
        client.subscribe(fn),
        ...sessions.flatMap(account => [
          account.identities.subscribe(fn),
          account.store.subscribe(fn),
        ]),
        ...choices.map(app => app.useP2p.subscribe(fn)),
      ]
      return () => off.forEach(stop => stop())
    },
    mask,
    mask
  )
  const current = () => {
    const dialog = owner.store.getState().activeDialog
    return dialog?.kind === 'peer_code' && dialog.request === request
  }
  const close = () => {
    if (current()) owner.store.getState().closeDialog()
  }
  if (chosen && request.valid(chosen)) {
    const account = request.owner(chosen)
    const valid = () => current() && request.valid(chosen)
    const finish = () => {
      if (!valid()) return
      close()
      if (client.shown() !== account) client.show(account)
      account.identities.show(chosen)
    }
    const routed = { close, valid, finish }
    return (
      <AccountProvider session={account}>
        <P2pProvider identity={chosen}>
          {link.kind === 'contact' ? (
            <AddContactDialog code={link.code} routed={routed} />
          ) : (
            <ServerNewDialog tab="join" code={link.code} routed={routed} />
          )}
        </P2pProvider>
      </AccountProvider>
    )
  }
  return (
    <Dialog title="Choose a P2P identity" onClose={close} compact>
      <div className="flex flex-col items-start gap-2">
        {chosen || !available.includes('1') ? (
          <p role="status">This P2P identity is no longer available.</p>
        ) : (
          choices.map(
            (app, i) =>
              available[i] === '1' && (
                <button
                  key={request.owner(app).renderKey + ':' + app.localId}
                  className={textBtn}
                  onClick={() => {
                    if (current() && request.valid(app)) choose(app)
                  }}
                >
                  <Masked text={app.useP2p.getState().name || app.localId} />
                  {choices.some(other => request.owner(other) !== request.owner(app)) && (
                    <Masked
                      text={` · ${request.owner(app).store.getState().me?.username}@${new URL(request.owner(app).conn.origin).host}`}
                    />
                  )}
                </button>
              )
          )
        )}
        <button className={textBtn} onClick={close}>
          Cancel
        </button>
      </div>
    </Dialog>
  )
}
