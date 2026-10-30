import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { resetSessionCaches, useStore } from '../store'
import { ServerRail } from '../../components/server_rail'
import { ConfigSyncSection } from '../../components/config_sync'
import { MarkdownMessage } from '../../components/markdown_message'
import { me, msg, user } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  Object.assign(initial, saved)
  resetSessionCaches()
})

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

const signedIn = (streamer: boolean, over = {}) =>
  Object.assign(initial, {
    streamer,
    me: me('alice', {
      servers: [
        {
          name: 'secret',
          display_name: 'Secret Hideout',
          creator: 'alice',
          is_admin: true,
          banner_color: null,
          name_color: null,
        },
      ],
    }),
    ...over,
  })

describe('streamer mode', () => {
  test('rail tooltips name no server', () => {
    signedIn(false)
    expect(render(<ServerRail />)).toContain('title="Secret Hideout (Creator)"')
    signedIn(true)
    const html = render(<ServerRail />)
    expect(html.includes('Secret Hideout')).toBe(false)
    expect(html).toContain('title="Server (Creator)"')
  })

  test('the previewed server tile names no server', () => {
    const view = { kind: 'channel', server: 'peek', channel: 1 }
    const servers = { peek: { display_name: 'Peeked Place' } }
    signedIn(false, { view, servers })
    expect(render(<ServerRail />)).toContain('Previewing Peeked Place')
    signedIn(true, { view, servers })
    const html = render(<ServerRail />)
    expect(html.includes('Peeked Place')).toBe(false)
    expect(html).toContain('title="Previewing a server"')
  })

  test('the config string stays covered until shown', () => {
    signedIn(false)
    const plain = render(<ConfigSyncSection />)
    expect(plain).toContain('aria-label="Config string"')
    expect(plain.includes('data-streamer-cover')).toBe(false)
    signedIn(true)
    const covered = render(<ConfigSyncSection />)
    expect(covered.includes('aria-label="Config string"')).toBe(false)
    expect(covered).toContain('aria-label="Show config string"')
    expect(covered).toContain('aria-label="Copy config string"')
  })

  test('P2P sender names stay out of tooltips and are blurred in text', () => {
    const media = {
      id: 'ab'.repeat(16),
      filename: 'notes.zip',
      kind: 'p2p' as const,
      hoster: 'bob',
      expires_at: null,
      size: 10,
      mime: null,
      sha256: null,
      removed: false,
      removed_by_author: false,
      spoiler: false,
    }
    const page = () =>
      render(<MarkdownMessage message={msg(3, { author: user('bob'), content: '', media })} />)
    signedIn(false, { settings: { ...saved.settings, p2p_attachments: true } })
    expect(page()).toContain('title="File not available. Ask bob to send it again."')
    signedIn(true, { settings: { ...saved.settings, p2p_attachments: true } })
    const html = page()
    expect(html).toContain('title="File not available. Ask the sender to send it again."')
    expect(/Ask <span class="streamer">[^<]*bob/.test(html)).toBe(true)
  })
})

describe('palette index', () => {
  test('spoiler text is never indexed', async () => {
    const { messageDoc } = await import('../palette_sync')
    const doc = messageDoc(
      useStore.getState(),
      'dm:1',
      msg(9, { dm_id: 1, channel_id: null, content: 'the hero ||dies at the end|| sadly' }),
      null
    )
    expect(doc?.text.includes('dies')).toBe(false)
    expect(doc?.text).toContain('sadly')
  })
})
