import { expect, test } from 'bun:test'
import { closePalette, openPalette } from '../palette_store'
import { Ended } from '../slices/ctx'
import type { InboxPage, InboxUntil } from '../types'
import { me, msg } from './fixtures'
import { testAccount } from './test_account'

test('home, palette preferences and search documents follow their own account', () => {
  const a = testAccount('sam', 'https://a.test')
  const b = testAccount('sam', 'https://b.test')
  try {
    for (const acct of [a, b]) {
      acct.home.startSync()
      acct.indexer.startIndexSync()
      acct.indexer.applyMode('loaded')
    }
    expect(a.home.useHome.getState().prefs.tips).not.toBe(b.home.useHome.getState().prefs.tips)
    expect(a.palettePrefs.usePaletteUi.getState().prefs.used).not.toBe(
      b.palettePrefs.usePaletteUi.getState().prefs.used
    )
    expect(a.apiDoc.useApiDoc.getState().history.items).not.toBe(
      b.apiDoc.useApiDoc.getState().history.items
    )
    a.home.hideTip('welcome')
    a.palettePrefs.noteUsed('friends')
    openPalette('query')
    expect(b.palettePrefs.usePaletteUi.getState().text).toBe('query')
    expect(b.palettePrefs.usePaletteUi.getState().prefs.used).toEqual({})
    expect(b.home.useHome.getState().prefs.tips).toEqual([])
    for (const [acct, content] of [
      [a, 'sunrise'],
      [b, 'moonrise'],
    ] as const) {
      acct.store.setState({ messages: { d3: [msg(1, { content, channel_id: null, dm_id: 3 })] } })
      expect(acct.indexer.paletteIndex()?.search(content).length).toBe(1)
    }
    expect(b.indexer.paletteIndex()?.search('sunrise')).toEqual([])
    const source = { id: 'custom', visible: () => true, open: () => {} }
    a.indexer.registerIndexSource(source)
    expect(b.indexer.indexSource('custom')).toBeUndefined()
    a.store.setState({ me: me('other') })
    expect(b.palettePrefs.usePaletteUi.getState().open).toBe(true)
    a.indexer.dispose()
    expect(b.indexer.paletteIndex()?.search('moonrise').length).toBe(1)
  } finally {
    closePalette()
  }
})

test('inbox watermarks and delayed responses belong to their requesting session', async () => {
  const a = testAccount('alice')
  const b = testAccount('bob')
  const view = { unread: true, place: null, kind: null }
  const bound = (pings: number) => ({ pings, groups: 0, friends: 0 })
  const pending = Promise.withResolvers<InboxPage>()
  const marked: InboxUntil[] = []
  b.api.inboxReadAll = async until => {
    marked.push(until)
  }
  a.api.inbox = () => pending.promise
  b.api.inbox = async () => ({ items: [], next: null, until: bound(2) })
  const late = a.inbox.instanceInbox.load(view, null)
  a.inbox.addInboxAdapter({ ...a.inbox.instanceInbox, id: 'custom' })
  expect(b.inbox.inboxAdapters().map(x => x.id)).toEqual(['instance'])
  await b.inbox.instanceInbox.load(view, null)
  a.inbox.dispose()
  pending.resolve({ items: [], next: null, until: bound(7) })
  const ended = await late.then(
    () => false,
    error => error instanceof Ended
  )
  expect(ended).toBe(true)
  await b.inbox.instanceInbox.markAll(view, [])
  expect(marked).toEqual([bound(2)])
})

test('disposing an API console drops only its outstanding document load', async () => {
  const a = testAccount('alice')
  const b = testAccount('bob')
  const pending = Promise.withResolvers<Response>()
  a.api.send = () => pending.promise
  b.api.send = async () => Response.json({ paths: {} })
  const late = a.apiDoc.loadApiDoc()
  await b.apiDoc.loadApiDoc()
  a.apiDoc.dispose()
  pending.resolve(Response.json({ paths: {} }))
  await late
  expect(a.apiDoc.useApiDoc.getState().ops).toBeNull()
  expect(b.apiDoc.useApiDoc.getState().ops).toEqual([])
})
