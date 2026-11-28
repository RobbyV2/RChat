import { describe, expect, test } from 'bun:test'
import {
  accountLabel,
  handleName,
  instanceAddress,
  instanceName,
  labelList,
  labelWith,
  masksName,
  nameLabel,
  nameLabeller,
  nameParts,
  nameText,
  nameTitle,
  p2pKey,
  p2pName,
  personCalled,
  personName,
  revealKeyOf,
  roomName,
  serverCalled,
  serverName,
  shownNameText,
  unnamed,
  type NameView,
} from '../names'
import { shownUser } from '../people'
import type { UserRef } from '../types'
import { user } from './fixtures'

const shown = (username: string, over: Partial<UserRef> = {}) =>
  shownUser(user(username, over), null)

const stars = (t: string) => t.replace(/darn/g, '****')
const view = (over: Partial<NameView> = {}): NameView => ({
  streamer: false,
  mask: stars,
  own: false,
  ...over,
})

describe('a person', () => {
  const ally = personName(shown('alice', { display_name: 'Ally' }))
  const alice = personName(shown('alice', { display_name: 'Alice' }))

  test('shows the username after a display name that is more than its case', () => {
    expect(nameParts(ally, true)).toEqual({ main: 'Ally', handle: 'alice' })
    expect(nameParts(ally, false)).toEqual({ main: 'Ally', handle: null })
    expect(nameParts(alice, true)).toEqual({ main: 'Alice', handle: null })
    expect(nameText(ally, true)).toBe('Ally (alice)')
    expect(nameText(ally)).toBe('Ally')
  })

  test('a webhook and a guest keep their own name', () => {
    const hook = personName(shown('@webhook:3', { display_name: 'Deploys' }))
    expect(nameParts(hook, true).handle).toBeNull()
    const guest = personName(shown('@guest:ab12cd', { display_name: 'Guest ab12' }))
    expect(nameParts(guest, true)).toEqual({ main: 'Guest ab12', handle: null })
  })

  test('the filter masks other people and never the viewer or a guest label', () => {
    const rude = personName(shown('darn', { display_name: 'darn it' }))
    expect(shownNameText(rude, view(), true)).toBe('**** it (****)')
    expect(shownNameText(rude, view({ own: true }), true)).toBe('darn it (darn)')
    const guest = personName(shown('@guest:darn00', { display_name: 'Guest darn' }))
    expect(masksName(guest, false)).toBe(false)
    expect(shownNameText(guest, view())).toBe('Guest darn')
  })

  test('who decides whose name it is: the username, or what the caller says', () => {
    expect(ally.who).toBe('alice')
    expect(ally.own).toBeUndefined()
    const peer = personName(shown('k1', { display_name: 'Pat' }), false)
    expect(peer.who).toBeNull()
    expect(peer.own).toBe(false)
    expect(handleName('bob').display).toBe('bob')
  })

  test('one reveal opens the pair', () => {
    expect(revealKeyOf(ally)).toBe('name:alice')
  })
})

describe('streamer mode', () => {
  const name = serverName({ name: 'den', display_name: 'darn Den' })

  test('a tooltip names nothing', () => {
    expect(nameTitle(name, view())).toBe('**** Den')
    expect(nameTitle(name, view({ streamer: true }))).toBeUndefined()
  })

  test('a line around labels keeps what each label says', () => {
    const den = nameLabel(name, view())
    expect<string>(labelWith`Open ${den}, ${2} unread`).toBe('Open **** Den, 2 unread')
    expect<string>(labelList([den, unnamed('a contact')])).toBe('**** Den, a contact')
  })

  test('labels for several names share one view of streamer mode', () => {
    const viewOf = (streamer: boolean) => () => view({ streamer })
    const shown = nameLabeller(false, view().mask, viewOf(false))
    const hidden = nameLabeller(true, view().mask, viewOf(true))
    expect<string>(shown(name)).toBe('**** Den')
    expect<string>(hidden(name, 'this server')).toBe('this server')
    expect(shown.line('Open server', () => labelWith`Open ${shown(name)}`)).toBe('Open **** Den')
    expect(hidden.line('Open server', () => labelWith`Open ${hidden(name)}`)).toBe('Open server')
    expect<string>(shown.covered('darn talk', 'Channel')).toBe('**** talk')
    expect<string>(shown.covered('darn talk', 'Channel', true)).toBe('darn talk')
    expect<string>(hidden.covered('darn talk', 'Channel', true)).toBe('Channel')
    expect(hidden.hiding).toBe(true)
  })

  test('a label says what kind of thing it is', () => {
    expect<string>(nameLabel(name, view())).toBe('**** Den')
    expect<string>(nameLabel(name, view({ streamer: true }))).toBe('Server')
    expect<string>(nameLabel(name, view({ streamer: true }), 'A server')).toBe('A server')
    expect<string>(nameLabel(p2pName('Pat'), view({ streamer: true }))).toBe('Contact')
    expect<string>(nameLabel(instanceName('Alpha'), view({ streamer: true }))).toBe('Instance')
    expect<string>(nameLabel(accountLabel('alice@a.test'), view({ streamer: true }))).toBe(
      'Account'
    )
    expect<string>(nameLabel(handleName('bob'), view({ streamer: true }))).toBe('Someone')
  })
})

describe('each kind and the filter', () => {
  test('a server falls back to its key, and a room has none', () => {
    expect(nameText(serverName({ name: 'den' }))).toBe('den')
    expect(serverName({ name: 'den', display_name: 'Den' }).server).toBe('den')
    expect(roomName('Club').server).toBeNull()
    expect(shownNameText(roomName('darn club'), view())).toBe('**** club')
    expect(shownNameText(roomName('darn club', true), view({ own: true }))).toBe('darn club')
  })

  test('a server or a person by a name alone', () => {
    expect(shownNameText(serverCalled('darn den'), view())).toBe('**** den')
    expect(serverCalled('Den', true).own).toBe(true)
    const named = personCalled('darn pat', 'pat')
    expect(named.who).toBe('pat')
    expect(nameParts(named, true)).toEqual({ main: 'darn pat', handle: null })
    expect(personCalled('Pat', null, true).own).toBe(true)
    expect(personCalled('Pat', 'pat', false).who).toBeNull()
  })

  test('an instance label is masked and an address is not', () => {
    expect(shownNameText(instanceName('darn chat'), view())).toBe('**** chat')
    expect(shownNameText(instanceAddress('darn.example'), view())).toBe('darn.example')
  })

  test('an account label is the viewer own text', () => {
    expect(masksName(accountLabel('darn@a.test'), false)).toBe(false)
  })

  test('a P2P name is masked and a fingerprint is not', () => {
    expect(shownNameText(p2pName('darn pat'), view())).toBe('**** pat')
    expect(shownNameText(p2pKey('darn 1234'), view())).toBe('darn 1234')
    expect(shownNameText(p2pName('darn pat', true), view({ own: true }))).toBe('darn pat')
  })

  test('with the filter off the name is as written', () => {
    const off = view({ mask: t => t })
    expect(shownNameText(p2pName('darn pat'), off)).toBe('darn pat')
  })
})
