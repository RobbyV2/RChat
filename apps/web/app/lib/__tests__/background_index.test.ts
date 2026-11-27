import { expect, test } from 'bun:test'
import { client } from '../client/client'
import { closePalette, openPalette } from '../palette_store'
import { me, msg } from './fixtures'
import { testAccount } from './test_account'

test('background logout and login discard the former owner’s searchable DMs and preferences', () => {
  const shown = client.shown()
  const background = testAccount('alice', 'https://background-index.test')
  try {
    background.indexer.startIndexSync()
    background.palettePrefs.setIndexMode('loaded')
    background.indexer.setIndexModeNow('loaded')
    background.palettePrefs.noteUsed('alice-command')
    background.store.setState({
      messages: { d1: [msg(1, { channel_id: null, dm_id: 1, content: 'private' })] },
    })
    expect(background.indexer.paletteIndex()?.search('private')).toHaveLength(1)
    openPalette('keep open')
    background.store.getState().logout()
    expect(background.indexer.paletteIndex()).toBeNull()
    background.store.setState({ me: me('bob') })
    expect(background.palettePrefs.usePaletteUi.getState()).toMatchObject({
      owner: 'bob',
      prefs: { index: 'off', used: {} },
    })
    background.indexer.setIndexModeNow('loaded')
    expect(background.indexer.paletteIndex()?.search('private')).toEqual([])
    expect(shown.palettePrefs.usePaletteUi.getState()).toMatchObject({
      open: true,
      text: 'keep open',
    })
  } finally {
    closePalette()
  }
})
