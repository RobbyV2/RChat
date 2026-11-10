import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { openContactMenu } from '../actions/p2p_contact'
import { EMPTY_NOTIFY, LEVELS, MUTE_CHOICES, setMute, type NotifyScope } from '../notify'
import { useP2p } from '../p2p/app'
import type { Contact } from '../p2p/contacts'
import { dmRoomId } from '../p2p/dm'
import { keyId, newKeyPair } from '../p2p/keys'
import { resetSessionCaches, useStore, type ConfirmRequest, type ContextMenuItem } from '../store'

const initial = useStore.getState()
const p2pInitial = useP2p.getState()

beforeAll(registerAppActions)

afterEach(() => {
  useStore.setState(initial, true)
  useP2p.setState(p2pInitial, true)
})

afterAll(resetSessionCaches)

const ME = keyId(newKeyPair().pk)
const DANA = keyId(newKeyPair().pk)

const contact = (ik: string, state: Contact['state'] = 'mutual') =>
  ({
    ik,
    name: ik === DANA ? 'Dana' : ik,
    petname: null,
    profile: null,
    certs: [],
    revocations: [],
    state,
    ignored: false,
    intros: [],
    verified: false,
    verifiedAt: null,
    added: 1,
  }) as unknown as Contact

const room: NotifyScope = { kind: 'p2p', room: dmRoomId(ME, DANA) }

// The contact's menu as the P2P page and Home's P2P card open it.
const menu = (c: Contact, me: string | null = ME) => {
  useP2p.setState({ contacts: [c] })
  return menuItems(ctxFor(useStore.getState(), { kind: 'p2p_contact', c, me }, 'menu'))
}
const labels = (items: ContextMenuItem[]) => items.map(i => i.label)

// Records the confirms each row asks for and the notification changes it makes.
const recorder = () => {
  const calls: unknown[][] = []
  useStore.setState({
    askConfirm: (c: ConfirmRequest) => void calls.push(['askConfirm', c.title, c.body, c.confirm]),
    muteScope: (scope: NotifyScope, until: unknown) =>
      void calls.push(['muteScope', scope, until === null ? null : 'later']),
    setNotifyLevel: (scope: NotifyScope, level: unknown) =>
      void calls.push(['setNotifyLevel', scope, level]),
  })
  return calls
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe("a P2P contact's menu", () => {
  test('a mutual contact: message, mute, notifications, rename, verify, block and remove', async () => {
    useStore.setState({ notifyPrefs: EMPTY_NOTIFY })
    const items = menu(contact(DANA))
    expect(labels(items)).toEqual([
      'Message',
      'Mute DM',
      'Notification settings',
      'Rename',
      'Verify',
      'Block',
      'Remove',
    ])
    expect(items.map(i => !!i.danger)).toEqual([false, false, false, false, false, true, true])
    const [, mute, settings] = items
    expect(labels(mute.submenu ?? [])).toEqual(MUTE_CHOICES.map(c => c.label))
    expect(labels(settings.submenu ?? [])).toEqual(LEVELS.map(l => l.label))
    const calls = recorder()
    mute.submenu![0].action!()
    settings.submenu!.find(i => i.label === LEVELS[0].label)!.action!()
    await settle()
    expect(calls).toEqual([
      ['muteScope', room, 'later'],
      ['setNotifyLevel', room, LEVELS[0].level],
    ])
  })

  test('a muted DM offers Unmute DM with when the mute ends', async () => {
    useStore.setState({ notifyPrefs: setMute(EMPTY_NOTIFY, room, 'forever') })
    const items = menu(contact(DANA))
    expect(labels(items).slice(0, 3)).toEqual(['Message', 'Unmute DM', 'Notification settings'])
    expect(!!items[1].subtitle).toBe(true)
    const calls = recorder()
    items[1].action!()
    await settle()
    expect(calls).toEqual([['muteScope', room, null]])
  })

  test('without a P2P identity of its own the menu has no notification rows', () => {
    expect(labels(menu(contact(DANA), null))).toEqual([
      'Message',
      'Rename',
      'Verify',
      'Block',
      'Remove',
    ])
  })

  test('a request not yet accepted can be renamed, verified, blocked or removed', () => {
    expect(labels(menu(contact(DANA, 'incoming')))).toEqual(['Rename', 'Verify', 'Block', 'Remove'])
  })

  test('a blocked contact only lifts the block, without a warning', () => {
    const items = menu(contact(DANA, 'blocked'))
    expect(labels(items)).toEqual(['Remove block'])
    expect(!!items[0].danger).toBe(false)
  })

  test('block and remove ask first, naming the contact unless streamer mode is on', async () => {
    const calls = recorder()
    const run = async (label: string) => {
      menu(contact(DANA)).find(i => i.label === label)!.action!()
      await settle()
    }
    await run('Block')
    await run('Remove')
    useStore.setState({ streamer: true })
    await run('Block')
    expect(calls).toEqual([
      [
        'askConfirm',
        'Block Dana?',
        'They can no longer reach you over P2P. You can remove the block later.',
        'Block',
      ],
      ['askConfirm', 'Remove Dana?', 'They stay able to send you a new request.', 'Remove'],
      [
        'askConfirm',
        'Block this contact?',
        'They can no longer reach you over P2P. You can remove the block later.',
        'Block',
      ],
    ])
  })

  test('the menu opens where it was asked for, and not for a contact that is gone', () => {
    useP2p.setState({ contacts: [contact(DANA)] })
    openContactMenu(12, 34, contact(DANA), ME)
    const open = useStore.getState().contextMenu
    expect([open?.x, open?.y]).toEqual([12, 34])
    expect(labels(open?.items ?? [])[0]).toBe('Message')
    useStore.getState().closeContextMenu()
    useP2p.setState({ contacts: [] })
    openContactMenu(12, 34, contact(DANA), ME)
    expect(useStore.getState().contextMenu).toBe(null)
  })
})
