'use client'

import { Name } from './name'
import { accountLabel } from '../lib/names'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { client } from '../lib/client/client'
import { railBlocks } from '../lib/client/rail_blocks'
import { AccountProvider, useAccount } from '../lib/client/react'
import { useP2p, P2pProvider } from '../lib/client/p2p_react'
import type { AccountSession } from '../lib/client/session'
import { createSwitcherSource, type SwitcherRow } from '../lib/client/switcher_rows'
import { switcherSession } from '../lib/client/switch_actor'
import { ownInstance } from '../lib/instances'
import { useStore } from '../lib/store'
import { useAddingAllowed } from './add_instance'
import { AccountTag, InstanceTag } from './account_tag'
import { Masked } from './ui'
import { Row, Stack, Surface } from './layout'
import { ContactRow } from './p2p/p2p_home'

export interface FriendAccount {
  account: AccountSession
  row: SwitcherRow
  name: string
  peers: SwitcherRow[]
}

export function useFriendAccounts() {
  const [source] = useState(createSwitcherSource)
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const allowed = useAddingAllowed()
  return railBlocks(rows.groups, allowed ? undefined : ownInstance()?.origin).blocks.flatMap(g =>
    g.accounts.flatMap(row => {
      const account = switcherSession(row)
      return row.username && account
        ? [
            {
              row,
              account,
              name: g.name,
              peers: g.peers.filter(p => p.username === row.username),
            },
          ]
        : []
    })
  )
}

export function FriendGroups({
  entries,
  children,
}: {
  entries: FriendAccount[]
  children: (entry: FriendAccount) => ReactNode
}) {
  const groups = new Map<string, FriendAccount[]>()
  for (const e of entries) {
    const g = groups.get(e.row.origin)
    if (g) g.push(e)
    else groups.set(e.row.origin, [e])
  }
  return (
    <>
      {Array.from(groups, ([origin, accounts]) => (
        <Stack key={origin} gap="md">
          {groups.size > 1 && (
            <h2 className="streamer text-xs font-semibold">
              <Surface as="span" tone="plain" radius="none" pad="sm" inset="bar">
                <Row as="span" gap="sm">
                  <InstanceTag origin={origin} name={accounts[0].name} />
                  <Masked text={accounts[0].name} />{' '}
                  <span className="font-normal text-on-surface-variant">
                    <Masked text={accounts[0].account.conn.host} />
                  </span>
                </Row>
              </Surface>
            </h2>
          )}
          {accounts.map(entry => (
            <FriendAccountSection key={entry.account.renderKey} entry={entry}>
              {children(entry)}
            </FriendAccountSection>
          ))}
        </Stack>
      ))}
    </>
  )
}

export function FriendAccountSection({
  entry,
  children,
}: {
  entry: FriendAccount
  children: ReactNode
}) {
  return (
    <AccountProvider session={entry.account}>
      <SignedSection entry={entry}>{children}</SignedSection>
    </AccountProvider>
  )
}

function SignedSection({ entry, children }: { entry: FriendAccount; children: ReactNode }) {
  const account = useAccount()
  const username = useStore(s => s.me?.username)
  useEffect(() => {
    if (!username && account.credentialTarget === entry.row.username)
      void account.store.getState().bootstrap()
  }, [account, username, entry.row.username])
  return (
    <section
      aria-label={entry.row.username + ' on ' + entry.name}
      data-friends-owner={account.renderKey}
    >
      <h3 className="font-medium">
        <Surface as="span" tone="plain" radius="none" pad="sm" inset="bar">
          <Row as="span" gap="sm">
            <AccountTag row={entry.row} name={entry.name} />
            <Name of={accountLabel(entry.name)} look="text-xs text-on-surface-variant" />
          </Row>
        </Surface>
      </h3>
      {username === entry.row.username ? (
        children
      ) : (
        <Surface tone="plain" radius="none" pad="sm" inset="bar">
          <p className="text-sm text-on-surface-variant">Loading account…</p>
        </Surface>
      )}
    </section>
  )
}

export function PeerFriendGroups({ entry, online }: { entry: FriendAccount; online: boolean }) {
  return (
    <AccountProvider session={entry.account}>
      {entry.peers.map(row => {
        const app = entry.account.identities.get(row.local!)
        return (
          app && (
            <P2pProvider identity={app} key={row.local}>
              <PeerFriends entry={entry} row={row} online={online} />
            </P2pProvider>
          )
        )
      })}
    </AccountProvider>
  )
}
function PeerFriends({
  entry,
  row,
  online,
}: {
  entry: FriendAccount
  row: SwitcherRow
  online: boolean
}) {
  const contacts = useP2p(s => s.contacts)
  const presence = useP2p(s => s.presence)
  const friends = contacts.filter(
    c => c.state === 'mutual' && (!online || presence[c.ik] === 'online')
  )
  return (
    <section
      className="rounded-xl border border-dashed border-tertiary"
      aria-label={row.display + ' P2P friends'}
    >
      <Surface tone="plain" radius="none" pad="sm" gap="sm">
        <h3>
          <AccountTag row={row} name={entry.name} />
        </h3>
        <ul
          onClickCapture={() => {
            const app = entry.account.identities.get(row.local!)
            if (app && (client.shown() === entry.account || client.show(entry.account)))
              entry.account.identities.show(app)
          }}
        >
          {friends.map(c => (
            <ContactRow key={c.ik} c={c} presence={presence[c.ik] ?? 'offline'} />
          ))}
        </ul>
        {!friends.length && (
          <p className="text-sm text-on-surface-variant">
            {online ? 'No contacts online.' : 'No contacts.'}
          </p>
        )}
      </Surface>
    </section>
  )
}
