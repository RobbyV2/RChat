import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountProvider } from '../client/react'
import { testAccount } from './test_account'
import { createPeerFixture } from './peer_fixture'
import { resetSessionCaches } from '../store'
import { formatStamp, fullTime } from '../timestamps'
import type { P2pMessage } from '../p2p/dm'
import type { Outgoing } from '../store_types'
import { GroupedRow, OutgoingRow, groupPadCls } from '../../components/message_pane'
import { NameWithUsername } from '../../components/display_name'
import { P2pRow } from '../../components/p2p/p2p_chat'
import { MessageToolbar } from '../../components/message_toolbar'
import { msg, user } from './fixtures'

afterAll(resetSessionCaches)

const AT = 1_800_000_000
const ms = AT * 1000

const SR = '<span class="streamer sr-only">'

// The text of the screen-reader-only author name, or null without one.
const srName = (html: string) => {
  const at = html.indexOf(SR)
  if (at < 0) return null
  return html.slice(at + SR.length, html.indexOf('</span><div', at)).replace(/<[^>]*>/g, '')
}

describe('a grouped instance row', () => {
  const html = renderToStaticMarkup(
    <GroupedRow
      name={<NameWithUsername user={user('alice', { display_name: 'Ally' })} />}
      ts={AT}
      size={36}
    >
      <p>second message</p>
    </GroupedRow>
  )

  test('names its author for screen readers only', () => {
    expect(srName(html)).toBe('Ally(alice)')
  })

  test('shows no avatar or visible name', () => {
    expect(html.includes('View profile')).toBe(false)
    expect(html.includes('<svg')).toBe(false)
    expect(html.slice(html.indexOf('</span><div')).includes('Ally')).toBe(false)
  })

  test('keeps hours and minutes in the gutter, the full date and time in its title', () => {
    expect(html).toContain(`title="${fullTime(ms)}"`)
    expect(html).toContain(`>${formatStamp(ms, 't', ms)}</time>`)
    const cls = html.match(/<time [^>]*class="([^"]*)"/)?.[1].split(' ') ?? []
    expect(cls).toContain('opacity-0')
    expect(cls).toContain('group-hover:opacity-100')
    expect(html).toContain('second message')
  })

  test('shows the gutter time on focus only with a fine pointer, so a tap leaves none', () => {
    const cls = html.match(/<time [^>]*class="([^"]*)"/)?.[1].split(' ') ?? []
    expect(cls).toContain('pointer-fine:group-focus-within:opacity-100')
    expect(cls).not.toContain('group-focus-within:opacity-100')
  })
})

test('rows of one group have no gap between them', () => {
  expect(groupPadCls(true, true)).toBe('pt-1.5 pb-1.5')
  expect(groupPadCls(true, false)).toBe('pt-1.5 pb-0.5')
  expect(groupPadCls(false, false)).toBe('pt-0.5 pb-0.5')
  expect(groupPadCls(false, true)).toBe('pt-0.5 pb-1.5')
})

const barCls = (html: string) =>
  html.match(/<div role="toolbar"[^>]*class="([^"]*)"/)?.[1].split(' ')

test('the toolbar straddles the top edge of its row', () => {
  const cls = barCls(
    renderToStaticMarkup(<MessageToolbar m={msg(1)} react={false} actions={[]} onMore={() => {}} />)
  )
  expect(cls).toContain('-top-5')
})

const p: P2pMessage = {
  id: 'e1',
  sender: 'ik-bob',
  ts: ms,
  sentTs: ms,
  sortKey: 'e1',
  seq: 1,
  body: 'hello there',
  reply: null,
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
}

const p2pRow = (first: boolean, last: boolean, over: Partial<P2pMessage> = {}, mine = false) => {
  const owner = testAccount('bob')
  try {
    createPeerFixture(owner, 'bob')
    return renderToStaticMarkup(
      <AccountProvider session={owner}>
        <P2pRow
          p={{ ...p, ...over }}
          m={msg(1, {
            author: user('ik-bob', { display_name: 'Bobby' }),
            content: 'hello there',
            created_at: AT,
          })}
          first={first}
          last={last}
          mine={mine}
          pendingTip="Waiting for them to come online"
          mentioned={false}
          divider={false}
          flash={false}
          canAct
          canDelete={false}
          editing={null}
          draftKey="room"
          threads={false}
          onMenu={() => {}}
          onCopy={() => {}}
          onJump={() => {}}
        />
      </AccountProvider>
    )
  } finally {
    owner.store.dispose()
  }
}

describe('a P2P row', () => {
  test('the first of its group shows the name and time', () => {
    const html = p2pRow(true, false)
    expect(srName(html) === null).toBe(true)
    expect(html).toContain('Bobby</span>')
    expect(html).toContain('pt-1.5 pb-0.5')
  })

  test('a later one shows the time in the gutter and names the sender for screen readers', () => {
    const html = p2pRow(false, true)
    expect(srName(html)).toBe('Bobby')
    expect(html).toContain('data-grouped')
    expect(html).toContain(`>${formatStamp(ms, 't', ms)}</time>`)
    expect(html).toContain('pt-0.5 pb-1.5')
    expect(html).toContain('hello there')
  })

  test('the toolbar sits the same on a header row and a grouped one', () => {
    const header = barCls(p2pRow(true, false))
    expect(header).toContain('-top-5')
    expect(barCls(p2pRow(false, true))).toEqual(header)
  })

  test('a grouped own send not yet delivered shows its clock in the gutter', () => {
    const html = p2pRow(false, true, { pending: true }, true)
    expect(html).toContain('data-grouped')
    const gutter = html.slice(html.indexOf('data-grouped'), html.indexOf('hello there'))
    expect(gutter).toContain('data-pending')
    expect(gutter).toContain('aria-label="Not delivered yet"')
    expect(gutter).toContain('title="Waiting for them to come online"')
  })

  test('a grouped own delivered send shows the time in the gutter', () => {
    const html = p2pRow(false, true, {}, true)
    const gutter = html.slice(html.indexOf('data-grouped'), html.indexOf('hello there'))
    expect(gutter).toContain(`>${formatStamp(ms, 't', ms)}</time>`)
    expect(gutter.includes('data-pending')).toBe(false)
  })
})

const outgoing = (status: Outgoing['status']): Outgoing => ({
  tempId: -1,
  key: 'c1',
  status,
  msg: msg(-1, {
    author: user('alice', { display_name: 'Ally' }),
    content: 'on its way',
    created_at: AT,
  }),
  pending: null,
  p2pExpiresIn: null,
  send: () => Promise.reject(new Error('unused')),
})

const outgoingRow = (status: Outgoing['status'], first: boolean) =>
  renderToStaticMarkup(
    <OutgoingRow
      o={outgoing(status)}
      author={user('alice', { display_name: 'Ally' })}
      server={null}
      place={{ first, last: true }}
      size={36}
      onJump={() => {}}
      onRetry={() => {}}
      onCancel={() => {}}
    />
  )

describe('a send on its way to the server', () => {
  test('continuing its group, it is a dimmed grouped row that tells screen readers it is sending', () => {
    const html = outgoingRow('sending', false)
    expect(html).toContain('data-grouped')
    expect(html).toContain('opacity-50')
    expect(html).toContain('pt-0.5 pb-1.5')
    expect(srName(html)).toBe('Ally(alice)')
    expect(html).toContain('<span class="sr-only">Sending</span>')
    expect(html.includes('View profile')).toBe(false)
    expect(html).toContain('on its way')
  })

  test('starting a group, it shows the header with its status', () => {
    const html = outgoingRow('queued', true)
    expect(html.includes('data-grouped')).toBe(false)
    expect(html).toContain('View profile')
    expect(html).toContain('>Queued</span>')
    expect(html).toContain('pt-1.5 pb-1.5')
  })

  test('a failed one shows its header with Retry and Delete, not dimmed', () => {
    const html = outgoingRow('failed', true)
    expect(html).toContain('Failed to send')
    expect(html).toContain('>Retry</button>')
    expect(html).toContain('>Delete</button>')
    expect(html.includes('opacity-50')).toBe(false)
  })
})
