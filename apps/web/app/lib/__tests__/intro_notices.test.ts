import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetSessionCaches } from '../store'
import {
  EMPTY_HOME,
  P2P_DM_INTRO,
  P2P_SERVER_INTRO,
  homeKey,
  legacyIntroKeys,
  noticeOpen,
} from '../home'
import { hideTip, loadHome, reloadHome, useHome } from '../home_store'
import { memoryStorage } from './fixtures'

afterAll(resetSessionCaches)

const open = (account: string | null, id: string) => {
  const { owner, prefs } = useHome.getState()
  return noticeOpen(owner, account, prefs, id)
}

const stored = (user: string) => JSON.parse(memoryStorage.getItem(homeKey(user)) ?? 'null')

const realWarn = console.warn

afterEach(() => {
  console.warn = realWarn
})

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  loadHome(null)
})

describe('closed notices', () => {
  test('nothing shows before the account is known, or for another account', () => {
    expect(noticeOpen(null, null, EMPTY_HOME, P2P_SERVER_INTRO)).toBe(false)
    expect(noticeOpen(null, 'alice', EMPTY_HOME, P2P_SERVER_INTRO)).toBe(false)
    expect(noticeOpen('alice', null, EMPTY_HOME, P2P_SERVER_INTRO)).toBe(false)
    expect(noticeOpen('alice', 'bob', EMPTY_HOME, P2P_SERVER_INTRO)).toBe(false)
    expect(noticeOpen('alice', 'alice', EMPTY_HOME, P2P_SERVER_INTRO)).toBe(true)
  })

  test('closing one keeps it closed for that account through a reload and sign in', () => {
    loadHome('alice')
    expect(open('alice', P2P_SERVER_INTRO)).toBe(true)
    hideTip(P2P_SERVER_INTRO)
    expect(open('alice', P2P_SERVER_INTRO)).toBe(false)
    expect(open('alice', P2P_DM_INTRO)).toBe(true)
    expect(stored('alice')).toMatchObject({ v: 1, tips: [P2P_SERVER_INTRO] })
    loadHome(null)
    loadHome('bob')
    expect(open('bob', P2P_SERVER_INTRO)).toBe(true)
    loadHome('alice')
    expect(open('alice', P2P_SERVER_INTRO)).toBe(false)
  })

  test('a notice closed in another tab closes here without a reload', () => {
    loadHome('alice')
    expect(open('alice', P2P_DM_INTRO)).toBe(true)
    memoryStorage.setItem(
      homeKey('alice'),
      JSON.stringify({ v: 1, recents: [], tips: [P2P_DM_INTRO] })
    )
    reloadHome()
    expect(open('alice', P2P_DM_INTRO)).toBe(false)
  })

  test('notices closed by older versions stay closed and their keys stay as they were', () => {
    const [[serverId, serverKey], [dmId, dmKey]] = legacyIntroKeys('alice')
    expect([serverId, dmId]).toEqual([P2P_SERVER_INTRO, P2P_DM_INTRO])
    expect(serverKey).toBe('rchat_p2p_server_intro:alice')
    expect(dmKey).toBe('rchat_p2p_intro:alice')
    memoryStorage.setItem(serverKey, '1')
    memoryStorage.setItem(dmKey, 'yes')
    memoryStorage.setItem(homeKey('alice'), '{not json')
    loadHome('alice')
    expect(open('alice', P2P_SERVER_INTRO)).toBe(false)
    expect(open('alice', P2P_DM_INTRO)).toBe(true)
    hideTip(P2P_DM_INTRO)
    expect(stored('alice').tips).toEqual([P2P_SERVER_INTRO, P2P_DM_INTRO])
    expect(memoryStorage.getItem(serverKey)).toBe('1')
    loadHome('bob')
    expect(open('bob', P2P_SERVER_INTRO)).toBe(true)
  })

  test('unreadable storage hides nothing and breaks nothing', () => {
    console.warn = () => {}
    Object.assign(globalThis, {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {},
      },
    })
    loadHome('alice')
    expect(open('alice', P2P_SERVER_INTRO)).toBe(true)
    hideTip(P2P_SERVER_INTRO)
    expect(open('alice', P2P_SERVER_INTRO)).toBe(false)
  })
})
