import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { DmRow } from '../../components/channel_sidebar'
import { MemberName } from '../../components/member_sidebar'
import { DisplayNameField, NameWithUsername, nameRevealKey } from '../../components/display_name'
import { MaskedWords } from '../../components/ui'
import { MarkdownMessage } from '../../components/markdown_message'
import { AuthorRow, DmPeer } from '../../components/message_pane'
import { SystemNotice } from '../../components/system_messages'
import { ActorHit } from '../../components/audit_log'
import { PreviewLine } from '../../components/invite_card'
import { VoterRow } from '../../components/poll_card'
import TimeoutDialogHost from '../../components/timeout_dialog'
import { DockPlace, Tile } from '../../components/voice_grid'
import { CreatorNote } from '../../components/webhooks_dialog'
import { paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { actionById, runAction } from '../actions/registry'
import {
  canEditDisplayName,
  displayNameError,
  dmPlaceholder,
  mentionHandle,
  nameWithUsername,
  showsUsername,
  tileName,
} from '../display_name'
import { DEFAULT_FEATURES } from '../features'
import { api } from '../instances'
import { setMasking, resetMasking } from '../profanity'
import { resetSessionCaches, useStore } from '../store'
import { ApiError } from '../api'
import { typerNames } from '../typing'
import { drain, me, member, msg, user } from './fixtures'

const realSet = api.setDisplayName
const initial = useStore.getInitialState()
const saved = { ...initial }

beforeAll(registerAppActions)

afterEach(() => {
  api.setDisplayName = realSet
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

afterAll(resetSessionCaches)

test('display names are 1 to 32 characters after trimming', () => {
  expect(displayNameError('  Ally  ')).toBe(null)
  expect(displayNameError('')).toBe('Type a display name')
  expect(displayNameError('   ')).toBe('Type a display name')
  expect(displayNameError('😀'.repeat(32))).toBe(null)
  expect(displayNameError('a'.repeat(33))).toBe('Display name must be at most 32 characters')
  expect(displayNameError(` ${'a'.repeat(32)} `)).toBe(null)
})

test('the username shows next to a display name that differs', () => {
  expect(showsUsername(user('alice', { display_name: 'Alice' }))).toBe(false)
  expect(showsUsername(user('alice', { display_name: 'ALICE' }))).toBe(false)
  expect(showsUsername(user('alice', { display_name: 'Ally' }))).toBe(true)
  const same = renderToStaticMarkup(
    <NameWithUsername user={user('alice', { display_name: 'Alice' })} />
  )
  expect(same).toBe('Alice')
  const other = renderToStaticMarkup(
    <NameWithUsername user={user('alice', { display_name: 'Ally' })} />
  )
  expect(other).toBe(USERNAME_AFTER('Ally', 'alice'))
})

// The display name truncates; the username keeps its place and its streamer class.
const USERNAME_AFTER = (display: string, username: string) =>
  `<span class="inline-flex max-w-full min-w-0 items-baseline"><span class="min-w-0 truncate">${display}</span><span class="streamer max-w-full shrink-0 truncate pl-1 text-on-surface-variant">(${username})</span></span>`

// In a narrow row: the display name truncates first, and a username with no room left wraps
// out of sight (it stays in the title and for screen readers).
const FITTED = (display: string, username: string) =>
  `<span class="flex h-[1lh] min-w-0 flex-wrap items-baseline overflow-hidden text-ellipsis"><span dir="auto" class="max-w-max min-w-0 flex-[1_1_4rem] truncate">${display}</span><span class="streamer shrink-0 pl-1 text-on-surface-variant">(${username})</span></span>`

test('a member list name fits its row, with the whole name in its title', async () => {
  const row = (u: ReturnType<typeof user>, color?: string) =>
    renderToStaticMarkup(<MemberName user={u} color={color} />)
  const cls = 'class="streamer min-w-0 flex-1 truncate text-sm"'
  expect(row(user('bob', { display_name: 'Robert' }))).toBe(
    `<span title="Robert (bob)" ${cls}>${FITTED('Robert', 'bob')}</span>`
  )
  expect(row(user('alice', { display_name: 'Alice' }), '#ff0000')).toBe(
    `<span title="Alice" style="color:#ff0000" ${cls}>Alice</span>`
  )
  Object.assign(initial, { streamer: true })
  expect(row(user('bob', { display_name: 'Robert' })).includes('title=')).toBe(false)
  Object.assign(initial, {
    streamer: false,
    profanityOn: true,
    profanityReady: true,
    me: me('alice'),
  })
  await setMasking(true, () => Promise.resolve(t => t.replace(/shit/g, '****')))
  try {
    expect(row(user('shit', { display_name: 'Robert' }))).toContain('title="Robert (****)"')
    expect(row(user('alice', { display_name: 'shit' }))).toContain('title="shit (alice)"')
    const revealed = (username: string) =>
      renderToStaticMarkup(
        <MaskedWords open={[nameRevealKey(username)]}>
          <MemberName user={user('shit', { display_name: 'shit head' })} />
        </MaskedWords>
      )
    expect(revealed('shit')).toContain('title="shit head (shit)"')
    expect(revealed('shit').includes('data-masked-word')).toBe(false)
    expect(revealed('fuck')).toContain('title="**** head (****)"')
  } finally {
    resetMasking()
  }
})

const impostor = user('bob', { display_name: 'alice' })

const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance

const render = (node: ReactElement) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>)

test('text and mentions name the account a display name belongs to', () => {
  expect(nameWithUsername(user('alice', { display_name: 'Alice' }))).toBe('Alice')
  expect(nameWithUsername(impostor)).toBe('alice (bob)')
  expect(mentionHandle(user('alice', { display_name: 'Alice' }))).toBe('Alice')
  expect(mentionHandle(impostor)).toBe('bob')
  const hook = user('@webhook:7', { display_name: 'Deploy bot' })
  expect(showsUsername(hook)).toBe(false)
  expect(nameWithUsername(hook)).toBe('Deploy bot')
  expect(render(<NameWithUsername user={hook} />)).toBe('Deploy bot')
})

test('message headers show the username next to a display name, fitted to the row', () => {
  const html = render(
    <AuthorRow author={impostor} server={null} size={36} meta={null}>
      hi
    </AuthorRow>
  )
  expect(html).toContain(`title="alice (bob)" role="button"`)
  expect(html).toContain(FITTED('alice', 'bob'))
  Object.assign(initial, { streamer: true })
  const streamer = render(
    <AuthorRow author={impostor} server={null} size={36} meta={null}>
      hi
    </AuthorRow>
  )
  expect(streamer.includes('title="alice (bob)"')).toBe(false)
})

test('join and leave lines show the username next to a display name', () => {
  const html = render(
    <SystemNotice
      m={msg(6, { kind: 'join', author: impostor, content: '' })}
      server="club"
      divider={null}
      onMenu={() => {}}
    />
  )
  expect(html).toContain(USERNAME_AFTER('alice', 'bob'))
})

test('a mention shows the username it resolves to', () => {
  Object.assign(initial, {
    token: 'tok',
    me: me('carol'),
    dms: [{ id: 9, other: impostor, is_self: false }],
  })
  const html = render(
    <MarkdownMessage
      message={msg(1, { channel_id: null, dm_id: 9, author: user('carol'), content: 'hi @bob' })}
    />
  )
  expect(html).toContain('data-mention="bob"')
  expect(html).toContain('>@bob</span>')
  expect(html.includes('@alice')).toBe(false)
})

test('DM headers and sidebar rows show the username next to a display name', () => {
  Object.assign(initial, { token: 'tok', me: me('carol') })
  const peer = render(<DmPeer other={impostor} />)
  expect(peer).toContain(USERNAME_AFTER('alice', 'bob'))
  expect(peer).toContain('<span class="flex shrink-0 max-sm:hidden">')
  expect(render(<DmPeer other={user('bob', { display_name: 'Bob' })} />)).toContain(
    '<span class="flex shrink-0">'
  )
  const row = render(
    <DmRow
      dm={{ id: 9, other: impostor, is_self: false }}
      active={false}
      unread={false}
      pings={0}
    />
  )
  expect(row).toContain(USERNAME_AFTER('alice', 'bob'))
})

test('DM composers address the username', () => {
  expect(dmPlaceholder(impostor, false)).toBe('Message @bob')
  expect(dmPlaceholder(user('alice', { display_name: 'Alice' }), false)).toBe('Message @alice')
  expect(dmPlaceholder(impostor, true)).toBe('Send a direct message')
  expect(dmPlaceholder(undefined, false)).toBe('Send a direct message')
})

test('the typing line names the account too', () => {
  useStore.setState({ typingOn: true, me: me('carol'), blocked: {}, typing: {} })
  useStore.getState().applyWsEvent({
    type: 'typing',
    scope: 'd9',
    username: 'bob',
    display_name: 'alice',
    until: Math.floor(Date.now() / 1000) + 5,
  } as never)
  expect(typerNames(useStore.getState().typing.d9)).toEqual(['alice (bob)'])
})

const settings = (display_names: boolean) => ({
  ...useStore.getState().settings,
  ...DEFAULT_FEATURES,
  display_names,
})

test('editing needs an account and the switch', () => {
  const s = () => useStore.getState()
  const a = actionById('display_name')
  const ctx = () => paletteCtx(s())
  useStore.setState({ me: null, guest: true, settings: settings(true) })
  expect(canEditDisplayName(s())).toBe(false)
  expect(a?.available(ctx())).toBe(false)
  useStore.setState({ me: me('alice'), guest: false, settings: settings(false) })
  expect(canEditDisplayName(s())).toBe(false)
  expect(a?.available(ctx())).toBe(false)
  useStore.setState({ settings: settings(true) })
  expect(canEditDisplayName(s())).toBe(true)
  expect(a?.available(ctx())).toBe(true)
})

test('the command opens settings at the field', async () => {
  useStore.setState({ me: me('alice'), guest: false, settings: settings(true) })
  expect(await runAction('display_name', paletteCtx(useStore.getState()))).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({ kind: 'settings', focus: 'display_name' })
})

test('the field shows the name and keeps the username in view', () => {
  Object.assign(initial, { me: me('alice', { display_name: 'Ally' }) })
  const html = renderToStaticMarkup(<DisplayNameField focus={false} />)
  expect(html).toContain('Display name')
  expect(html).toContain('value="Ally"')
  expect(html).toContain('<span class="streamer">@alice</span>')
})

test('saving keeps the server copy and reports its errors', async () => {
  const sent: string[] = []
  let fail: ApiError | null = null
  api.setDisplayName = async (name: string) => {
    sent.push(name)
    if (fail) throw fail
    return {
      ...user('alice', { display_name: name }),
      banner_color: null,
      bio: null,
      appear_offline: false,
    }
  }
  useStore.setState({ me: me('alice'), guest: false, settings: settings(true) })
  expect(await useStore.getState().setDisplayName('  Ally ')).toBe(null)
  expect(useStore.getState().me?.display_name).toBe('Ally')
  fail = new ApiError('That name is reserved', 400)
  expect(await useStore.getState().setDisplayName('Instance staff')).toBe('That name is reserved')
  expect(useStore.getState().me?.display_name).toBe('Ally')
  expect(await useStore.getState().setDisplayName('   ')).toBe('Type a display name')
  expect(sent).toEqual(['Ally', 'Instance staff'])
  useStore.setState({ me: null, settings: { ...settings(true), registration: 'open' } })
  expect(await useStore.getState().setDisplayName('Ally')).toBe(
    'Create an account to change your display name'
  )
  useStore.setState({ settings: { ...settings(true), registration: 'closed' } })
  expect(await useStore.getState().setDisplayName('Ally')).toBe(
    'Log in to change your display name'
  )
  expect(sent).toEqual(['Ally', 'Instance staff'])
})

test('the voice dock, poll voters, invite previews and staff tools name the account too', () => {
  Object.assign(initial, { token: 'tok', me: me('carol') })
  const shown = USERNAME_AFTER('alice', 'bob')
  expect(render(<DockPlace peer={impostor} place="alice" />)).toBe(shown)
  expect(render(<DockPlace place="general" />)).toBe('general')
  expect(render(<VoterRow v={{ user: impostor, voted_at: 1 }} />)).toContain(shown)
  expect(
    render(<PreviewLine message={msg(1, { author: impostor, content: 'hi' })} big={false} />)
  ).toContain(shown)
  expect(
    render(<ActorHit m={member('bob', { display_name: 'alice' })} onPick={() => {}} />)
  ).toContain(shown)
  const note = render(<CreatorNote creator={impostor} />)
  expect(
    note.startsWith(
      '<p class="flex min-w-0 text-xs text-on-surface-variant"><span class="shrink-0 pr-1">by</span>'
    )
  ).toBe(true)
  expect(note).toContain(shown)
  Object.assign(initial, { activeDialog: { kind: 'timeout', server: 's', user: impostor } })
  expect(render(<TimeoutDialogHost />)).toContain(shown)
})

// A P2P identity's key, which stands where an account's username stands.
const KEY = 'Qk3xZ9'.padEnd(43, 'a')

const tileOf = (u: ReturnType<typeof user>, p2p: { own: boolean } | null, screen = false) => ({
  ...(p2p ? { local: true, own: p2p.own } : {}),
  key: screen ? `${u.username}:screen` : u.username,
  user: u,
  stream: null,
  hasVideo: false,
  muted: false,
  deafened: false,
  speaking: false,
  mirror: false,
  pending: false,
  tint: '#336699',
  screen,
  shareId: null,
})

test('a voice tile names a P2P identity by its P2P name and an account with its username', () => {
  const plain = (text: string) => text
  const stars = (text: string) => text.replace(/shit/g, '****')
  expect(tileName(user(KEY, { display_name: 'Alice' }), true, plain)).toBe('Alice')
  expect(tileName(user(KEY, { display_name: 'shit head' }), true, stars)).toBe('**** head')
  expect(tileName(user('alice', { display_name: 'Ally' }), false, plain)).toBe('Ally (alice)')
  expect(tileName(user('alice', { display_name: 'Alice' }), false, plain)).toBe('Alice')
  expect(tileName(user('@guest:abcd1234', { display_name: 'Guest abcd' }), false, stars)).toBe(
    'Guest abcd'
  )
})

test('a P2P voice tile shows the P2P name and keeps the key out of its labels', () => {
  Object.assign(initial, { token: 'tok', me: me('carol') })
  const alice = user(KEY, { display_name: 'Alice' })
  const tile = (t: ReturnType<typeof tileOf>, server: string | null = null) =>
    render(<Tile tile={t} server={server} focused={false} compact={false} onToggle={() => {}} />)
  const outside = (html: string, key: string) => html.replace(`data-tile="${key}"`, '')
  const theirs = tile(tileOf(alice, { own: false }))
  expect(theirs).toContain('<span class="streamer truncate">Alice</span>')
  expect(theirs).toContain('aria-label="Focus Alice"')
  expect(outside(theirs, KEY).includes(KEY)).toBe(false)
  const mine = tile(tileOf(alice, { own: true }))
  expect(mine).toContain('<span class="streamer truncate">Alice</span>')
  expect(outside(mine, KEY).includes(KEY)).toBe(false)
  const screen = tile(tileOf(alice, { own: false }, true))
  expect(screen).toContain('aria-label="Focus Alice&#x27;s screen"')
  expect(outside(screen, `${KEY}:screen`).includes(KEY)).toBe(false)
  const account = tile(tileOf(user('alice', { display_name: 'Ally' }), null), 's')
  expect(account).toContain(
    `<span class="streamer truncate">${USERNAME_AFTER('Ally', 'alice')}</span>`
  )
  expect(account).toContain('aria-label="Focus Ally (alice)"')
})
