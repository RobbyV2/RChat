import { shownPeer } from './shown_peer'
import { HostedServer } from '../place/place'
import { client } from '../client/client'
import { afterEach, beforeAll, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { DmRow } from '../../components/channel_sidebar'
import { MemberName } from '../../components/member_sidebar'
import { Row } from '../../components/layout'
import type { Look } from '../role_looks'
import { DisplayNameField, nameRevealKey } from '../../components/display_name'
import { Name } from '../../components/name'
import { personName } from '../names'
import { shownUser } from '../people'
import { MaskedWords } from '../../components/ui'
import { MarkdownMessage } from '../../components/markdown_message'
import { DmPeer } from '../../components/message_pane'
import { AuthorRow } from '../../components/message_row'
import { useFace } from '../place/use_looks'
import { SystemNotice } from '../../components/system_messages'
import { ActorHit } from '../../components/audit_log'
import { PreviewLine } from '../../components/invite_card'
import { VoterRow } from '../../components/poll_card'
import TimeoutDialogHost from '../../components/timeout_dialog'
import { DockPlace, Tile } from '../../components/voice_grid'
import { VOICE_STATUS_ON } from '../voice_status'
import { CreatorNote } from '../../components/webhooks_dialog'
import { ReplyPreview } from '../../components/replies'
import { PeerRow } from './helpers/peer_row'
import { asMessage } from '../p2p/shown_message'
import { PlaceProvider } from '../place/react'
import { peerPlace } from './helpers/peer_place'
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
import { api } from './home_instance'
import { setMasking, resetMasking } from '../profanity'
import { useStore } from '../store'
import { ApiError } from '../api'
import { typerNames } from '../typing'

import type { P2pMessage } from '../p2p/dm'
import type { ReplyRef, UserRef } from '../types'
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
    <Name of={personName(shownUser(user('alice', { display_name: 'Alice' }), null))} withUsername />
  )
  expect(same).toBe('<span class="streamer">Alice</span>')
  const other = renderToStaticMarkup(
    <Name of={personName(shownUser(user('alice', { display_name: 'Ally' }), null))} withUsername />
  )
  expect(other).toBe(`<span class="streamer">${USERNAME_AFTER('Ally', 'alice')}</span>`)
})

// The display name truncates; the username keeps its place.
const USERNAME_AFTER = (display: string, username: string) =>
  `<span class="min-w-0 flex-nowrap gap-(--space-2xs) items-baseline justify-start inline-flex max-w-full"><span class="min-w-0 truncate">${display}</span><span class="max-w-full shrink-0 truncate text-on-surface-variant">(${username})</span></span>`

// In a narrow row: the display name truncates first, and a username with no room left wraps
// out of sight (it stays in the title and for screen readers).
const FITTED = (display: string, username: string) =>
  `<span class="flex min-w-0 flex-wrap gap-(--space-2xs) items-baseline justify-start h-lh text-ellipsis min-w-0 overflow-hidden"><span dir="auto" class="max-w-max min-w-0 shrink grow basis-16 truncate">${display}</span><span class="shrink-0 text-on-surface-variant">(${username})</span></span>`

test('a member list name fits its row, with the whole name in its title', async () => {
  const row = (u: ReturnType<typeof user>, color?: string, icon?: Look['icon']) =>
    renderToStaticMarkup(<MemberName user={shownUser(u, null)} color={color} icon={icon} />)
  const cls = 'class="streamer min-w-0 truncate text-sm"'
  const box = (inner: string) =>
    renderToStaticMarkup(
      <Row as="span" gap="2xs" place="flex-1">
        {'@'}
      </Row>
    ).replace('@', inner)
  expect(row(user('bob', { display_name: 'Robert' }))).toBe(
    box(`<span title="Robert (bob)" ${cls}>${FITTED('Robert', 'bob')}</span>`)
  )
  expect(row(user('alice', { display_name: 'Alice' }), '#ff0000')).toBe(
    box(`<span title="Alice" style="color:#ff0000" ${cls}>Alice</span>`)
  )
  expect(
    row(user('alice', { display_name: 'Alice' }), undefined, { emoji: 'x', role: 'Mods' })
  ).toContain('<span role="img" title="Mods" aria-label="Mods" data-role-icon="true"')
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
          <MemberName user={shownUser(user('shit', { display_name: 'shit head' }), null)} />
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
  expect(render(<Name of={personName(shownUser(hook, null))} withUsername />)).toBe(
    '<span class="streamer">Deploy bot</span>'
  )
})

function FaceRow() {
  return (
    <AuthorRow face={useFace(impostor)} size={36} meta={null}>
      hi
    </AuthorRow>
  )
}

test('message headers show the username next to a display name, fitted to the row', () => {
  const html = render(<FaceRow />)
  expect(html).toContain(`title="alice (bob)" role="button"`)
  expect(html).toContain(FITTED('alice', 'bob'))
  Object.assign(initial, { streamer: true })
  const streamer = render(<FaceRow />)
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
  expect(render(<DockPlace peer={impostor} place="alice" />)).toBe(
    `<span class="streamer">${shown}</span>`
  )
  expect(render(<DockPlace place="general" />)).toBe('<span class="streamer">general</span>')
  expect(render(<VoterRow v={{ user: impostor, voted_at: 1 }} />)).toContain(shown)
  expect(
    render(<PreviewLine message={msg(1, { author: impostor, content: 'hi' })} big={false} />)
  ).toContain(shown)
  expect(
    render(<ActorHit m={member('bob', { display_name: 'alice' })} server="s" onPick={() => {}} />)
  ).toContain(shown)
  const note = render(<CreatorNote creator={impostor} />)
  expect(/^<p[^>]*><span class="[^"]*">by<\/span>/.test(note)).toBe(true)
  expect(note).toContain(shown)
  Object.assign(initial, {
    activeDialog: {
      kind: 'timeout',
      place: HostedServer.open(client.shown(), 's'),
      who: impostor.username,
      known: impostor,
    },
  })
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
  status: VOICE_STATUS_ON,
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

const quoteOf = (author: UserRef, over: Partial<ReplyRef> = {}): ReplyRef => ({
  id: 7,
  author,
  content: 'see you there',
  has_media: false,
  deleted: false,
  mention: false,
  ...over,
})

const P2P_NAME = (title: string | null, text: string) =>
  `<span${title === null ? '' : ` title="${title}"`} class="streamer min-w-0 truncate font-medium text-on-surface">${text}</span>`

test('a P2P reply quote shows the P2P name, with the key only in its title', () => {
  const alice = user(KEY, { display_name: 'Alice' })
  const quote = (q: ReplyRef) =>
    render(<ReplyPreview quote={q} avatar={36} local onJump={() => {}} />)
  const html = quote(quoteOf(alice))
  expect(html).toContain(P2P_NAME(KEY, 'Alice'))
  expect(html.replace(`title="${KEY}"`, '').includes(KEY)).toBe(false)
  expect(quote(quoteOf(alice, { mention: true }))).toContain(P2P_NAME(KEY, '@Alice'))
  Object.assign(initial, { streamer: true })
  const streamer = quote(quoteOf(alice))
  expect(streamer).toContain(P2P_NAME(null, 'Alice'))
  expect(streamer.includes(KEY)).toBe(false)
  Object.assign(initial, { streamer: false })
  const account = render(<ReplyPreview quote={quoteOf(impostor)} avatar={36} onJump={() => {}} />)
  expect(account).toContain(FITTED('alice', 'bob'))
})

test('a P2P reply quote masks the P2P name of others only', async () => {
  const named = user(KEY, { display_name: 'shit head' })
  Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('carol') })
  await setMasking(true, () => Promise.resolve(t => t.replace(/shit/g, '****')))
  try {
    const quote = (self: string) =>
      render(
        <PlaceProvider place={peerPlace(shownPeer(), { me: self })}>
          <ReplyPreview quote={quoteOf(named)} avatar={36} local onJump={() => {}} />
        </PlaceProvider>
      )
    const theirs = quote('someone else')
    expect(theirs).toContain('data-masked-word')
    expect(theirs.includes('shit')).toBe(false)
    expect(quote(KEY)).toContain(P2P_NAME(KEY, 'shit head'))
  } finally {
    resetMasking()
  }
})

const BOB_KEY = 'Bx7pW2'.padEnd(43, 'b')

const p2pMessage = (over: Partial<P2pMessage> = {}): P2pMessage => ({
  id: 'e2',
  sender: BOB_KEY,
  ts: 1_700_000_000_000,
  sentTs: 1_700_000_000_000,
  sortKey: 'b',
  seq: 2,
  body: 'sounds good',
  reply: { id: 'e1', sender: KEY, body: 'see you there' },
  mentions: [],
  fwd: null,
  att: [],
  edited: null,
  reactions: [],
  pinned: null,
  late: false,
  pending: false,
  failed: false,
  call: null,
  ...over,
})

test('a P2P message quotes the sender it answers by P2P name', () => {
  const names: Record<string, string> = { [KEY]: 'Alice', [BOB_KEY]: 'Bob' }
  const p = p2pMessage()
  const m = asMessage(p, 2, 1, ik => shownPeer().p2pUser(ik, names[ik]), BOB_KEY)
  const html = render(
    <PlaceProvider place={peerPlace(shownPeer(), { me: BOB_KEY })}>
      <PeerRow app={shownPeer()} p={p} m={m} me={BOB_KEY} />
    </PlaceProvider>
  )
  const quote = html.slice(html.indexOf('data-reply-to'), html.indexOf('sounds good'))
  expect(quote).toContain(P2P_NAME(KEY, 'Alice'))
  expect(quote.replace(`title="${KEY}"`, '').includes(KEY)).toBe(false)
})
