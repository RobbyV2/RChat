import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { resetSessionCaches, useStore } from '../store'
import { ServerRail } from '../../components/server_rail'
import { ConfigSyncSection } from '../../components/config_sync'
import { MarkdownMessage } from '../../components/markdown_message'
import { Banners } from '../../components/banners'
import { ConfirmDialog } from '../../components/server_settings'
import { P2pHome } from '../../components/p2p/p2p_home'
import { P2pSection } from '../../components/p2p/p2p_settings'
import { useP2p } from '../p2p/app'
import type { P2pState } from '../p2p/app/store'
import { offText } from '../p2p/blobs'
import { uncheckable } from '../p2p/badge'
import { squatted } from '../p2p/node'
import type { RChatState } from '../store_types'
import { me, msg, user } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const p2pInitial = useP2p.getInitialState()
const p2pSaved = { ...p2pInitial }

afterEach(() => {
  Object.assign(initial, saved)
  Object.assign(p2pInitial, p2pSaved)
  useP2p.setState(p2pSaved)
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

  test('the config string stays covered until shown, in and out of streamer mode', () => {
    for (const streamer of [false, true]) {
      signedIn(streamer)
      const html = render(<ConfigSyncSection />)
      expect(html.includes('aria-label="Config string"')).toBe(false)
      expect(html).toContain('aria-label="Show config string"')
      expect(html).toContain('aria-label="Copy config string"')
      expect(html.includes('Hidden in streamer mode')).toBe(streamer)
    }
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

describe('the instance name in toasts, errors and status text', () => {
  const ALPHA = { name: 'Alpha', id: 'a', version: '1', api_version: '1' } as RChatState['instance']
  const named = (over: Partial<RChatState> = {}) =>
    signedIn(true, { instance: ALPHA, instanceHost: 'chat.a.test', ...over })
  const running = (over: Partial<P2pState>) =>
    Object.assign(p2pInitial, { enabled: true, loading: false, account: 'alice', ...over })
  const SPAN = '<span class="streamer">Alpha</span>'
  // The name shows only inside streamer spans.
  const hidden = (html: string) =>
    html.includes(SPAN) && !html.split(SPAN).join('').includes('Alpha')

  test('a toast and an error banner', () => {
    named({ toast: { id: 1, text: offText('Alpha') } })
    expect(hidden(render(<Banners />))).toBe(true)
    named({ error: `Couldn't reach Alpha.` })
    expect(hidden(render(<Banners />))).toBe(true)
  })

  test('a confirmation', () => {
    named({
      confirm: {
        title: 'Forward',
        body: 'This copies the message to Alpha.',
        confirm: 'Copy',
        action: () => {},
      },
    })
    expect(hidden(render(<ConfirmDialog />))).toBe(true)
  })

  test('the P2P status line and P2P errors', () => {
    named()
    running({ status: 'squatted' })
    expect(hidden(render(<P2pHome onMenu={() => {}} />))).toBe(true)
    running({ status: 'online', error: squatted('Alpha') })
    expect(hidden(render(<P2pSection />))).toBe(true)
    running({ status: 'online', badgeError: uncheckable('Alpha') })
    expect(hidden(render(<P2pSection />))).toBe(true)
  })
})
