import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SearchView } from '../../components/search_panel'
import { MessageLinkCard } from '../../components/message_link_card'
import { PreviewLine } from '../../components/invite_card'
import { ReplyPreview } from '../../components/replies'
import { ForwardBar } from '../../components/forwards'
import { client } from '../client/client'
import { clipOf, fwdSource, p2pForward, type ForwardClip } from '../forward'
import { clipSourceNames, frameCopyOpen } from '../forward_viewing'
import { locateOnce } from '../forward_locate'
import { b64u } from '../p2p/canonical'
import type { ServerView } from '../p2p/server/types'
import { shownPeer } from './shown_peer'
import { pinnedPreview } from '../invite'
import { instanceInbox } from '../inbox_source'
import { home } from './home_instance'
import { resetSessionCaches, useStore } from '../store'
import type { ForwardRef, Message, MessageLocation } from '../types'
import { channelTarget, markPersonally, requestViewing } from '../viewing'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'
import { searchResults } from './helpers/loads'
import { writeJson } from '../api/masks'
import { answerPrompt } from './helpers/viewing'
import { defaultViewing } from '../viewing'

// Server rendering reads the store's initial state, so the test state goes there too.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setBoth = (part: Partial<typeof initial>) => {
  Object.assign(initial, part)
  useStore.setState(part)
}

afterEach(() => {
  Object.assign(initial, saved)
  resetSessionCaches()
  memoryStorage.clear()
})

const TEXT = 'Amber overlay bound folio'
const general = {
  id: 1,
  name: 'general',
  kind: 'text' as const,
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const proofroom = { ...general, id: 2, name: 'proofroom', sensitive: true }
const fwd = (over: Partial<ForwardRef> = {}): ForwardRef => ({
  origin_server: null,
  origin_server_channel: null,
  author: user('writer'),
  created_at: 1,
  source_id: 40,
  origin: '#proofroom - Club',
  origin_channel: 'proofroom',
  origin_channel_id: 2,
  origin_sensitive: true,
  dropped: null,
  ...over,
})
const copy = (over: Partial<ForwardRef> = {}): Message =>
  msg(41, { channel_id: 1, content: TEXT, author: user('writer'), forward: fwd(over) })
const signedIn = () =>
  setBoth({
    me: me('reader'),
    servers: { club: serverDetail('club', { channels: [general, proofroom] }) },
  })
const openOnce = async (id: number, sensitive: boolean) => {
  const opening = requestViewing(
    channelTarget(useStore.getState().me?.username ?? null, 'instance', 'club', { id, sensitive })
  )
  answerPrompt(defaultViewing, true, false)
  await opening
}

const search = (m: Message) =>
  renderToStaticMarkup(
    <SearchView
      channels={undefined}
      seed={{ q: 'folio', n: 0 }}
      results={searchResults({
        hits: [
          {
            key: String(m.id),
            channel: 'general',
            server: 'club',
            ownPlace: false,
            author: null,
            createdAt: m.created_at,
            content: m.content,
            own: false,
            forwarded: true,
            file: null,
            copy: { message: m, server: 'club' },
            onOpen: () => {},
          },
        ],
      })}
      scrollForMore={() => false}
      onRun={() => {}}
      onClose={() => {}}
    />
  )

test('a search hit of a forwarded copy from a closed room shows no text until that room opens', async () => {
  signedIn()
  expect(search(copy())).not.toContain(TEXT)
  expect(search(copy())).toContain('Forwarded message')
  expect(search(copy())).toContain('Reveal preview')
  await openOnce(2, true)
  expect(search(copy())).toContain(TEXT)
})

test('a link card to a forwarded copy follows its source room', async () => {
  signedIn()
  const card: MessageLocation = {
    id: 41,
    server: 'club',
    channel_id: 1,
    dm_id: null,
    thread_root_id: null,
    author: user('writer'),
    created_at: 2,
    content: TEXT,
    has_media: false,
    kind: 'user',
    forwarded: true,
    forward: fwd(),
  }
  setBoth({ linkCards: { 41: card } })
  const link = {
    kind: 'message' as const,
    id: 41,
    thread: null,
    place: { kind: 'channel' as const, server: 'club', channelId: 1 },
  }
  const html = () => renderToStaticMarkup(<MessageLinkCard link={link} />)
  expect(html()).toContain('Forwarded message')
  expect(html()).toContain('Reveal preview')
  expect(html()).not.toContain(TEXT)
  await openOnce(2, true)
  expect(html()).toContain(TEXT)
})

test('a signed-out invite preview decides a forwarded copy by the label it carries', () => {
  const line = (m: Message) => renderToStaticMarkup(<PreviewLine message={m} big server="club" />)
  expect(line(copy())).not.toContain(TEXT)
  expect(line(copy())).toContain('Forwarded message')
  expect(line(copy())).toContain('Reveal preview')
  expect(line(copy({ origin_sensitive: false }))).toContain(TEXT)
  markPersonally(channelTarget(null, 'instance', 'club', { id: 2 }), true)
  expect(line(copy({ origin_sensitive: false }))).not.toContain(TEXT)
  expect(line(copy({ origin_dm: true, origin_channel_id: null }))).toContain(TEXT)
})

test('a frame shows copies from its own room and from rooms open in its profile', async () => {
  const frame = { origin: 'https://chat.example', scoped: (key: string) => key }
  const room = { server: 'club', channel_id: 1 }
  expect(frameCopyOpen(fwd(), room, null, frame)).toBe(false)
  expect(frameCopyOpen(fwd({ origin_channel_id: 1 }), room, null, frame)).toBe(true)
  expect(frameCopyOpen(fwd({ origin_sensitive: false }), room, null, frame)).toBe(true)
  expect(frameCopyOpen(fwd({ origin_channel_id: null }), room, null, frame)).toBe(true)
  const opening = requestViewing(
    channelTarget(null, 'instance', 'club', { id: 2, sensitive: true }, frame)
  )
  answerPrompt(defaultViewing, true, false)
  await opening
  expect(frameCopyOpen(fwd(), room, null, frame)).toBe(true)
  expect(frameCopyOpen(fwd(), room, 'reader', frame)).toBe(false)
})

test('a pinned invite preview reports a changed room instead of dropping the answer', () => {
  const invite = {
    preview_channel_id: 1,
    preview_sensitive: true,
    preview_channel: 'general',
    preview: [],
  }
  expect(pinnedPreview({ id: 1, label: false }, invite)).toEqual({
    messages: null,
    changed: { id: 1, label: true, name: 'general' },
  })
  expect(pinnedPreview({ id: 1, label: true }, invite)).toEqual({ messages: [], changed: null })
})

test('a closed voice room keeps its people out of the client until it opens', async () => {
  const lounge = {
    id: 3,
    name: 'lounge',
    kind: 'voice' as const,
    slowmode_seconds: 0,
    category_id: null,
    my_perms: null,
    topic: null,
  }
  const recordings = { ...lounge, id: 4, name: 'recordings', sensitive: true }
  useStore.setState({
    me: me('reader'),
    servers: { club: serverDetail('club', { channels: [general, lounge, recordings] }) },
  })
  const ws = home.ws as unknown as { resubscribe: () => void }
  const real = ws.resubscribe
  let refreshed = 0
  ws.resubscribe = () => refreshed++
  try {
    const st = () => useStore.getState()
    st().applyWsEvent({
      type: 'voice_state',
      server: 'club',
      channel_id: 4,
      users: ['writer'],
      audio: null,
    })
    st().applyWsEvent({
      type: 'voice_state',
      server: 'club',
      channel_id: 3,
      users: ['writer'],
      audio: null,
    })
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'club',
      channel_id: 4,
      username: 'writer',
      muted: true,
    })
    expect(st().voiceUsers).toEqual({ 3: ['writer'] })
    expect(st().voiceMuted).toEqual({})
    markPersonally(channelTarget('reader', 'instance', 'club', lounge), true)
    expect(st().voiceUsers).toEqual({})
    expect(refreshed).toBe(0)
    const opening = requestViewing(channelTarget('reader', 'instance', 'club', recordings))
    answerPrompt(defaultViewing, true, false)
    await opening
    expect(refreshed).toBe(1)
    st().applyWsEvent({
      type: 'voice_state',
      server: 'club',
      channel_id: 4,
      users: ['writer'],
      audio: null,
    })
    expect(st().voiceUsers).toEqual({ 4: ['writer'] })
  } finally {
    ws.resubscribe = real
  }
})

test('a reply quoting a forwarded copy follows the copy source room', async () => {
  signedIn()
  const quote = {
    id: 41,
    author: user('writer'),
    content: TEXT,
    has_media: false,
    deleted: false,
    mention: false,
    forwarded: true,
    forward: fwd(),
  }
  const html = () =>
    renderToStaticMarkup(<ReplyPreview quote={quote} avatar={36} onJump={() => {}} />)
  expect(html()).not.toContain(TEXT)
  expect(html()).toContain('Forwarded')
  expect(html()).toContain('Reveal preview')
  await openOnce(2, true)
  expect(html()).toContain(TEXT)
})

test('a hit from a closed room offers its own reveal instead of its text', () => {
  signedIn()
  const target = channelTarget('reader', 'instance', 'club', proofroom)
  const html = renderToStaticMarkup(
    <SearchView
      channels={undefined}
      seed={{ q: 'folio', n: 0 }}
      results={searchResults({
        hits: [
          {
            key: '50',
            channel: 'proofroom',
            server: 'club',
            ownPlace: false,
            author: null,
            createdAt: 1,
            content: '',
            own: false,
            forwarded: false,
            file: null,
            reveal: target,
            onOpen: () => {},
          },
        ],
      })}
      scrollForMore={() => false}
      onRun={() => {}}
      onClose={() => {}}
    />
  )
  expect(html).toContain('Reveal preview')
})

test('a closed inbox entry names the room whose choice reveals it', () => {
  signedIn()
  const entry = {
    raw: { server: 'club', scope: 'c2' },
  } as unknown as Parameters<NonNullable<typeof instanceInbox.previewTarget>>[0]
  expect(instanceInbox.canPreview?.(entry)).toBe(false)
  expect(instanceInbox.previewTarget?.(entry)?.key).toBe(
    channelTarget('reader', 'instance', 'club', proofroom).key
  )
})

const answering = async (id: number, place: Record<string, unknown> | Response) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () =>
    place instanceof Response
      ? place
      : new Response(writeJson(place), { status: 200 })) as unknown as typeof fetch
  try {
    await locateOnce(client.shown(), id)
  } finally {
    globalThis.fetch = real
  }
}

test('the forward bar offers "Show where it\'s from" and says what the server will name', async () => {
  signedIn()
  setBoth({
    view: { kind: 'channel', server: 'club', channelId: 1 },
    forwardClip: clipOf(msg(40, { channel_id: 1, content: TEXT }), 'club'),
    forwardShowSource: null,
  })
  const bar = () => renderToStaticMarkup(<ForwardBar list="main" />)
  const unknown = bar()
  expect(unknown).toContain('role="switch" aria-checked="true"')
  expect(unknown).toContain(
    'title="Show where it&#x27;s from" aria-label="Show where it&#x27;s from"'
  )
  expect(unknown).toContain('Checking where it&#x27;s from')
  expect(/title="Checking where it&#x27;s from" disabled=""/.test(unknown)).toBe(true)
  await answering(40, new Response('oops', { status: 500 }))
  const failed = bar()
  expect(failed).toContain('Couldn&#x27;t check where it&#x27;s from.')
  expect(failed).toContain('>Retry</button>')
  expect(/title="Checking where it&#x27;s from" disabled=""/.test(failed)).toBe(true)
  const place = { server: 'club', channel_id: 1, dm_id: null, thread_root_id: null }
  await answering(40, { ...place, shown: { server: 'Book Club', channel: 'general' } })
  expect(
    /From <span class="streamer[^"]*">Book Club<\/span> &gt; #<span class="streamer[^"]*">general</.test(
      bar()
    )
  ).toBe(true)
  setBoth({ forwardShowSource: { key: 'c1', on: false } })
  const off = bar()
  expect(off).toContain('aria-checked="false"')
  expect(off).toContain('Where it&#x27;s from stays hidden')
  setBoth({ forwardShowSource: { key: 'c2', on: false } })
  expect(bar()).toContain('aria-checked="true"')
  setBoth({
    forwardShowSource: null,
    forwardClip: clipOf(msg(42, { channel_id: 1, content: TEXT }), 'club'),
  })
  await answering(42, { ...place, shown: { server: 'Book Club' } })
  const restricted = bar()
  expect(restricted).toContain('Book Club')
  expect(restricted).not.toContain('&gt; #')
  setBoth({ forwardClip: clipOf(msg(43, { channel_id: 1, content: TEXT }), 'club') })
  await answering(43, { ...place, shown: null })
  expect(bar()).toContain('Where it&#x27;s from stays hidden')
  setBoth({ forwardClip: clipOf(msg(41, { channel_id: null, dm_id: 3, content: TEXT })) })
  const fromDm = bar()
  expect(fromDm).toContain('data-forward-bar')
  expect(fromDm).not.toContain('role="switch"')
  expect(fromDm).not.toContain('data-forward-source')
})

test('a forward into P2P names its original and, when shown, what the sender may name', async () => {
  const room = b64u(new Uint8Array(32).fill(1))
  const [beds, hush] = [b64u(new Uint8Array(8).fill(2)), b64u(new Uint8Array(8).fill(3))]
  const ev = b64u(new Uint8Array(32).fill(4))
  const peer = shownPeer()
  const before = peer.useP2p.getState().servers
  peer.useP2p.setState({
    servers: {
      [room]: {
        id: room,
        name: 'Garden',
        me: 'join',
        seq: 0,
        chans: {},
        members: [],
        channels: [
          { id: beds, name: 'beds', over: {}, everyoneSees: true },
          { id: hush, name: 'hush', over: {}, everyoneSees: false },
        ],
      } as unknown as ServerView,
    },
  })
  try {
    const clip = (ch: string): ForwardClip => ({
      source: { kind: 'p2p', room, ch },
      id: 3,
      author: user('bob', { display_name: 'Bob' }),
      snippet: 'q',
      has_media: false,
      created_at: 5,
      body: 'q',
      p2p: true,
      ev,
    })
    const send = (c: ForwardClip, show: boolean) =>
      p2pForward(c, fwdSource(c.source, clipSourceNames(client.shown(), c), show))
    const base = { name: 'Bob', ts: 5000, body: 'q', ev }
    expect(send(clip(beds), true)).toEqual({ ...base, src: { rn: 'Garden', cn: 'beds' } })
    expect(send(clip(hush), true)).toEqual({ ...base, src: { rn: 'Garden' } })
    expect(send(clip(beds), false)).toEqual(base)
    const fromDm = { ...clip(beds), source: { kind: 'direct' as const } }
    expect(send(fromDm, false)).toEqual({ ...base, src: { dm: true } })
    // An instance message: only what the server answered, nothing before it has.
    signedIn()
    const hosted: ForwardClip = {
      source: { kind: 'channel', id: 1, server: 'club' },
      id: 50,
      author: user('bob', { display_name: 'Bob' }),
      snippet: 'q',
      has_media: false,
      created_at: 5,
      body: 'q',
    }
    const plain = { name: 'Bob', ts: 5000, body: 'q' }
    expect(send(hosted, true)).toEqual(plain)
    await answering(50, {
      server: 'club',
      channel_id: 1,
      dm_id: null,
      thread_root_id: null,
      shown: { server: 'Vault' },
    })
    expect(send(hosted, true)).toEqual({ ...plain, src: { rn: 'Vault' } })
    expect(send(hosted, false)).toEqual(plain)
  } finally {
    peer.useP2p.setState({ servers: before })
  }
})
