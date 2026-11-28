import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStore } from '../store'
import {
  ForwardCard,
  ForwardSourcePill,
  FrameForwardPill,
  P2pSourcePill,
  useVouchedFiles,
} from '../../components/forwards'
import { P2pProvider } from '../client/p2p_react'
import { textHash, type ForwardPill, type HeldOriginal } from '../forward_pill'
import type { Contact } from '../p2p/contacts'
import type { Attachment, FwdPlace } from '../p2p/content'
import type { ServerView } from '../p2p/server/types'
import { shownPeer } from './shown_peer'
import { fullTimeOf } from '../timestamps'
import type { ForwardRef } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there too.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setBoth = (part: Partial<typeof initial>) => {
  Object.assign(initial, part)
  useStore.setState(part)
}

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(saved)
})

const NAME = 'Bartholomew the Magnificent Third'

const card = () =>
  renderToStaticMarkup(
    <ForwardCard
      m={msg(9, {
        content: 'wha',
        author: user('carol'),
        forward: {
          author: { ...user('bart'), display_name: NAME },
          created_at: 3,
          source_id: 5,
          origin_dm: true,
          origin: 'Direct message',
          dropped: null,
          origin_channel: null,
          origin_channel_id: null,
          origin_server: null,
          origin_server_channel: null,
        },
      })}
      canDelete={false}
    />
  )

describe('forward card author', () => {
  test('a long name truncates beside its avatar; only the time wraps', () => {
    const html = card()
    const group = html.match(
      /<span data-forward-author="true" class="([^"]*)">([\s\S]*?)<\/span><time/
    )
    expect(group === null).toBe(false)
    const [, cls, inner] = group ?? []
    expect(cls.split(' ').includes('flex')).toBe(true)
    expect(cls.split(' ').includes('flex-wrap')).toBe(false)
    expect(cls.split(' ').includes('min-w-0')).toBe(true)
    expect(inner).toContain('title="View profile"')
    expect(inner).toContain(NAME)
  })
})

const general = {
  id: 1,
  name: 'general',
  kind: 'text' as const,
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const reading = {
  id: 7,
  name: 'reading',
  kind: 'text' as const,
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
}
const ref = (over: Partial<ForwardRef> = {}): ForwardRef => ({
  origin_channel: null,
  origin_channel_id: null,
  origin_server: null,
  origin_server_channel: null,
  author: user('bart'),
  created_at: 3,
  source_id: 5,
  origin: null,
  dropped: null,
  ...over,
})
const pill = (p: ForwardPill, frame = false) =>
  renderToStaticMarkup(
    <ForwardSourcePill
      pill={p}
      when="then"
      frame={frame}
      openServer={() => {}}
      openOriginal={() => {}}
    />
  )
const CANT = 'You can&#x27;t open this'
const PHOTO = { h: 'photo', size: 10, blocks: 1, name: 'beds.png', mime: 'image/png' }

function Files({ place }: { place: FwdPlace }) {
  return <i>{JSON.stringify(useVouchedFiles(place))}</i>
}

describe('forward source pill', () => {
  test('the pill opens the source server, and the original from its channel button with its time', () => {
    setBoth({
      me: me('reader'),
      servers: {
        club: serverDetail('club', { display_name: 'Book Club', channels: [general, reading] }),
      },
    })
    const html = renderToStaticMarkup(
      <ForwardCard
        m={msg(9, {
          channel_id: 1,
          content: 'see this',
          forward: ref({
            origin: '#reading - Book Club',
            origin_channel: 'reading',
            origin_channel_id: 7,
            origin_server: 'Book Club',
          }),
        })}
        canDelete={false}
      />
    )
    expect(html).not.toContain('Originally sent')
    expect(html).toContain('data-forward-pill="open"')
    expect(html).toContain('Forwarded from')
    const channel = html.match(/<button[^>]*title="([^"]*)"[^>]*>(?:(?!<\/button>).)*reading/)
    expect(channel?.[1]).toBe(`Open the original message, sent ${fullTimeOf(3)}`)
    expect(html).toContain('title="Open Book Club"')
    expect(html.match(/class="streamer[^"]*"/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('somewhere the viewer can’t open: the carried names, then a lock', () => {
    const html = pill({ kind: 'named', server: 'Vault', channel: 'lobby', pending: false })
    expect(html).toContain('Vault')
    expect(html).toContain('lobby')
    expect(html).toContain(`role="img" title="${CANT}" aria-label="${CANT}"`)
    expect(html).not.toContain('<button')
    const looking = pill({ kind: 'named', server: 'Vault', channel: null, pending: true })
    expect(looking).toContain('Vault')
    expect(looking).not.toContain(CANT)
    expect(pill({ kind: 'hidden' })).toContain('Forwarded from')
    expect(pill({ kind: 'hidden' })).toContain('somewhere you can&#x27;t access')
    expect(pill({ kind: 'none' })).toBe('')
  })

  test('a direct message opens only for its participants', () => {
    expect(pill({ kind: 'dm', open: true })).toContain(
      'title="Open the original message, sent then"'
    )
    expect(pill({ kind: 'dm', open: false })).not.toContain('<button')
    expect(pill({ kind: 'dm', open: false })).toContain('a direct message')
  })

  test('a P2P server shows its initial and opens like an instance one', () => {
    const html = pill({
      kind: 'open',
      server: { key: 'room', name: 'Garden', p2p: true },
      channel: { id: 'c1', name: 'beds' },
    })
    expect(html).toContain('>G</span>')
    expect(html.match(/<button/g)?.length).toBe(2)
  })

  test('frames render the pill without buttons', () => {
    const open = pill(
      {
        kind: 'open',
        server: { key: 'club', name: 'Book Club', p2p: false },
        channel: { id: 7, name: 'reading' },
      },
      true
    )
    expect(open).toContain('reading')
    expect(open).not.toContain('<button')
    const named = renderToStaticMarkup(
      <FrameForwardPill
        fwd={ref({ origin: 'Vault', origin_server: 'Vault', origin_server_channel: 'lobby' })}
      />
    )
    expect(named).toContain('Vault')
    expect(named).not.toContain('<button')
    expect(named).not.toContain(CANT)
    const dm = renderToStaticMarkup(
      <FrameForwardPill fwd={ref({ origin: 'Direct message', origin_dm: true })} />
    )
    expect(dm).toContain('a direct message')
    expect(dm).not.toContain('<button')
    expect(renderToStaticMarkup(<FrameForwardPill fwd={ref()} />)).toBe('')
  })

  test('a P2P copy links its original only while the original vouches for it', () => {
    const app = shownPeer()
    const initialP2p = app.useP2p.getInitialState()
    const servers = {
      R: {
        id: 'R',
        name: 'Garden',
        me: 'join',
        seq: 0,
        chans: {},
        owner: null,
        owners: [],
        members: [],
        channels: [{ id: 'c1', name: 'beds', over: {}, everyoneSees: true }],
      } as unknown as ServerView,
    }
    const contacts = [
      { ik: 'IK_ALICE', name: 'Alice', petname: 'Mom', state: 'mutual' } as unknown as Contact,
    ]
    const before = {
      servers: initialP2p.servers,
      contacts: initialP2p.contacts,
      live: app.useP2p.getState().servers,
      liveContacts: app.useP2p.getState().contacts,
    }
    Object.assign(initialP2p, { servers, contacts })
    app.useP2p.setState({ servers, contacts })
    const realPlace = app.eventPlace
    const original = (room: string, ch: string | null): HeldOriginal => ({
      room,
      ch,
      sender: 'IK_ALICE',
      ts: [5000],
      texts: [textHash('plans')],
      atts: [PHOTO],
    })
    let held: HeldOriginal | null = original('R', 'c1')
    Object.assign(app, { eventPlace: () => held })
    const copy: FwdPlace = {
      ev: 'e'.repeat(43),
      dm: false,
      rn: 'Old garden',
      cn: 'old beds',
      ts: 5000,
      body: 'plans',
      atts: [PHOTO],
    }
    const render = (place = copy) =>
      renderToStaticMarkup(
        <P2pProvider identity={app}>
          <P2pSourcePill place={place} when="then" />
        </P2pProvider>
      )
    try {
      const open = render()
      expect(open).toContain('data-forward-pill="open"')
      expect(open).toContain('>G</span>')
      expect(open).toContain('beds')
      expect(open).not.toContain('Old garden')
      expect(open.match(/<button/g)?.length).toBe(2)
      expect(open).toContain('title="Open the original message, sent then"')
      for (const forged of [
        render({ ...copy, body: 'give Mallory the keys' }),
        render({ ...copy, atts: [PHOTO, { ...PHOTO, h: 'mallory' }] }),
        render({ ...copy, atts: [{ ...PHOTO, name: 'invoice.pdf' }] }),
      ]) {
        expect(forged).toContain('data-forward-pill="named"')
        expect(forged).toContain('Old garden')
        expect(forged).toContain(CANT)
        expect(forged).not.toContain('<button')
      }
      // The card names the author as the viewer does once the original vouches, else as the
      // copy claims.
      const card = (body: string) =>
        renderToStaticMarkup(
          <P2pProvider identity={app}>
            <ForwardCard
              m={msg(9, {
                channel_id: null,
                content: body,
                forward: {
                  ...ref({ author: { ...user('Claimed'), display_name: 'Claimed Alice' } }),
                  source_id: 0,
                  p2p: { ...copy, body },
                },
              })}
              canDelete={false}
              local
            />
          </P2pProvider>
        )
      // Its files show as the original holds them.
      held = { ...original('R', 'c1'), atts: [{ ...PHOTO, x: 'as held' } as Attachment] }
      const files = (place: FwdPlace) =>
        renderToStaticMarkup(
          <P2pProvider identity={app}>
            <Files place={place} />
          </P2pProvider>
        )
      expect(files(copy)).toContain('as held')
      expect(files({ ...copy, atts: [{ ...PHOTO, name: 'invoice.pdf' }] })).toBe('<i>null</i>')
      held = original('R', 'c1')
      expect(card('plans')).toContain('Mom')
      expect(card('plans')).not.toContain('Claimed Alice')
      expect(card('altered plans')).toContain('Claimed Alice')
      held = null
      expect(render()).toContain(CANT)
      held = original('D', null)
      const dm = render({ ...copy, dm: true, rn: null, cn: null })
      expect(dm).toContain('a direct message')
      expect(dm).toContain('<button')
      expect(render({ ...copy, ev: null, rn: null, cn: null })).toBe('')
    } finally {
      Object.assign(app, { eventPlace: realPlace })
      Object.assign(initialP2p, { servers: before.servers, contacts: before.contacts })
      app.useP2p.setState({ servers: before.live, contacts: before.liveContacts })
    }
  })
})
