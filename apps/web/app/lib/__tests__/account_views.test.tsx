import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import SearchPanel from '../../components/search_panel'
import { client } from '../client/client'
import { AccountProvider } from '../client/react'
import { startApp } from '../start'
import { msg, serverDetail, textChannel } from './fixtures'
import { testAccount } from './test_account'

test('search results use the viewing consent of their account for colliding channels', async () => {
  const first = testAccount('reader', 'https://first.test')
  const second = testAccount('reader', 'https://second.test')
  const shown = client.shown
  try {
    client.shown = () => first
    for (const account of [first, second]) {
      const message = msg(1, { content: 'Private search result' })
      account.store.setState({
        servers: {
          club: serverDetail('club', { channels: [{ ...textChannel(1), sensitive: true }] }),
        },
        search: {
          results: [{ message, server: 'club', channel_name: 'general' }],
          hasMore: false,
          loading: false,
          cursor: null,
        },
      })
      Object.assign(account.store.getInitialState(), account.store.getState())
    }
    const target = first.viewing.instanceTarget(first.store.getState(), 'club', 1)!
    const pending = first.viewing.requestViewing(target)
    first.viewing.useViewing.getState().prompt!.answer(true, false)
    await pending
    const render = (account: typeof first) =>
      renderToStaticMarkup(
        <AccountProvider session={account}>
          <SearchPanel />
        </AccountProvider>
      )
    expect(render(first)).toContain('Private search result')
    expect(render(second)).toContain('Reveal preview')
    expect(render(second)).not.toContain('Private search result')
  } finally {
    client.shown = shown
    first.store.dispose()
    second.store.dispose()
  }
})

test('startup restores the saved session for the requested instance', async () => {
  const first = testAccount('reader', 'https://first.test')
  const second = testAccount('reader', 'https://second.test')
  const started: string[] = []
  const shown = client.shown
  const key = second.conn.scoped('rchat_token')
  try {
    client.shown = () => first
    localStorage.setItem(key, 'saved')
    for (const account of [first, second]) {
      account.store.setState({
        token: null,
        guest: false,
        me: null,
        bootstrap: async () => {
          started.push(account.id)
        },
        setStreamer: () => {},
      })
    }
    await startApp(() => started.push('login'), second)
    expect(started).toEqual([second.id])
  } finally {
    client.shown = shown
    localStorage.removeItem(key)
    first.store.dispose()
    second.store.dispose()
  }
})
