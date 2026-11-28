import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UserAvatar } from '../../components/user_avatar'
import { KeyAvatar } from '../../components/p2p/p2p_badge'
import { ownColor, type AvatarMode } from '../avatar_setting'
import { asAccount, pictured, shownUser } from '../people'
import { useStore } from '../store'

const ID = '0123456789abcdef0123456789abcdef'
// A static render reads the store's first state.
const first = useStore.getInitialState()
const saved = { settings: first.settings, streamer: first.streamer, avatarMode: first.avatarMode }

afterEach(() => void Object.assign(first, saved))

const served = (on: boolean, streamer = false, avatarMode: AvatarMode = 'pictures') =>
  void Object.assign(first, {
    settings: { ...saved.settings, profile_pictures: on },
    streamer,
    avatarMode,
  })

const carol = (image: string | null) =>
  pictured('carol', { kind: 'identicon', color: null, image }, 'own')

describe('an avatar with an uploaded picture', () => {
  test('the built-in avatar draws first and the picture waits over it in the same box', () => {
    served(true)
    const plain = renderToStaticMarkup(<UserAvatar person={carol(null)} size={32} />)
    const html = renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)
    expect(plain.startsWith('<img')).toBe(true)
    expect(html).toContain(plain)
    expect(html).toContain('data-avatar-picture="loading"')
    expect(html).toContain('style="width:32px;height:32px"')
    expect(html).toContain(`/avatars/${ID}/64"`)
    expect(html).toContain('opacity-0')
  })

  test('a larger drawing asks for a larger stored size', () => {
    served(true)
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={48} />)).toContain(
      `/avatars/${ID}/128"`
    )
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={96} />)).toContain(
      `/avatars/${ID}/512"`
    )
  })

  test('no picture is asked for while the site serves none or in streamer mode', () => {
    served(false)
    const plain = renderToStaticMarkup(<UserAvatar person={carol(null)} size={32} />)
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)).toBe(plain)
    served(true, true)
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)).toBe(plain)
  })
})

describe('what this device draws', () => {
  const dave = pictured('dave', { kind: 'color', color: '#112233', image: ID }, 'own')

  test('built-in avatars only: each person keeps their kind and no picture is asked for', () => {
    served(true, false, 'builtin')
    const html = renderToStaticMarkup(<UserAvatar person={dave} size={32} />)
    expect(html).not.toContain('/avatars/')
    expect(html).toContain('background:#112233')
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)).toContain(
      'data:image/svg+xml'
    )
  })

  test('a forced kind draws everyone with it, accounts and P2P identities alike', () => {
    served(true, false, 'identicon')
    const forced = renderToStaticMarkup(<UserAvatar person={dave} size={32} />)
    expect(forced).toContain('data:image/svg+xml')
    expect(forced).not.toContain('/avatars/')
    expect(forced).not.toContain('#112233')
    const key = pictured('k1', { kind: 'color', color: '#445566' }, 'contact')
    const disc = 'background-color:#445566'
    expect(renderToStaticMarkup(<KeyAvatar person={key} size={32} />)).not.toContain(disc)
    served(true, false, 'color')
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)).toContain(
      `background:${ownColor('carol')}`
    )
    expect(renderToStaticMarkup(<KeyAvatar person={key} size={32} />)).toContain(disc)
    const plain = pictured('k2', { kind: 'identicon', color: null }, 'contact')
    expect(renderToStaticMarkup(<KeyAvatar person={plain} size={32} />)).toContain(
      `background-color:${ownColor('k2')}`
    )
  })

  test('streamer mode keeps a forced kind', () => {
    served(true, true, 'color')
    expect(renderToStaticMarkup(<UserAvatar person={carol(ID)} size={32} />)).toContain(
      `background:${ownColor('carol')}`
    )
  })
})

describe('the picture a person carries', () => {
  const account = {
    username: 'bob',
    display_name: 'Bob',
    avatar_kind: 'identicon' as const,
    avatar_color: null,
    avatar_image: ID,
  }
  const other = 'f'.repeat(32)

  test('an account keeps its picture, and one without the field has none', () => {
    expect(asAccount(account, 'dm').avatar_image).toBe(ID)
    expect(shownUser(account, null).avatar_image).toBe(ID)
    const { avatar_image: _, ...bare } = account
    expect(asAccount(bare, 'dm').avatar_image).toBeUndefined()
  })

  test('a look with its own picture shows it, over its own kind or the account kind', () => {
    const named = { name: 'Robert', avatar_kind: null, avatar_color: null }
    expect(shownUser(account, named).avatar_image).toBe(ID)
    expect(shownUser(account, { ...named, avatar_image: other }).avatar_image).toBe(other)
    const kind = { name: null, avatar_kind: 'color' as const, avatar_color: '#112233' }
    expect(shownUser(account, kind).avatar_image).toBeUndefined()
    const both = shownUser(account, { ...kind, avatar_image: other })
    expect([both.avatar_kind, both.avatar_image]).toEqual(['color', other])
  })
})
