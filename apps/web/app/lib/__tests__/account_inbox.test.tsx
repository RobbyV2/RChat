import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InboxButton } from '../../components/inbox'
import { client } from '../client/client'
import { AccountProvider } from '../client/react'
import { testAccount } from './test_account'

test('the inbox bell renders counts from its nearest provider', () => {
  const a = testAccount('a')
  const b = testAccount('b')
  const shown = client.shown
  try {
    client.shown = () => a
    a.inbox.addInboxAdapter({ ...a.inbox.instanceInbox, id: 'extra', count: () => 7 })
    b.inbox.addInboxAdapter({ ...b.inbox.instanceInbox, id: 'extra', count: () => 3 })
    expect(renderToStaticMarkup(<InboxButton />)).toContain('aria-label="Inbox, 7 notifications"')
    expect(
      renderToStaticMarkup(
        <AccountProvider session={b}>
          <InboxButton />
        </AccountProvider>
      )
    ).toContain('aria-label="Inbox, 3 notifications"')
  } finally {
    client.shown = shown
    a.store.dispose()
    b.store.dispose()
  }
})

test('existing badge subscribers follow added, replaced and removed adapters until disposal', () => {
  const account = testAccount('a')
  const { inbox } = account
  const counts: number[] = []
  const source = () => {
    const listeners = new Set<() => void>()
    let count = 0
    return {
      listeners,
      emit() {
        count++
        listeners.forEach(fn => fn())
      },
      adapter: {
        ...inbox.instanceInbox,
        id: 'p2p',
        count: () => count,
        subscribe(fn: () => void) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
      },
    }
  }
  const a = source()
  const b = source()
  const off = inbox.subscribeCounts(() => counts.push(inbox.adapterCounts()))
  try {
    inbox.addInboxAdapter(a.adapter)
    a.emit()
    inbox.addInboxAdapter(b.adapter)
    expect(a.listeners.size).toBe(0)
    a.emit()
    b.emit()
    inbox.removeInboxAdapter('p2p')
    expect(b.listeners.size).toBe(0)
    b.emit()
    inbox.addInboxAdapter(a.adapter)
    inbox.dispose()
    expect(a.listeners.size).toBe(0)
    expect(counts).toEqual([0, 1, 0, 1, 0, 2, 0])
  } finally {
    off()
    account.store.dispose()
  }
})
