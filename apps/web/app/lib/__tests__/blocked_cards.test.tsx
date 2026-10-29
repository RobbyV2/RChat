import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStore, resetSessionCaches } from '../store'
import { ForwardCard } from '../../components/forwards'
import { MessageLinkCard } from '../../components/message_link_card'
import { me, msg, user } from './fixtures'

afterAll(resetSessionCaches)

const forward = (author: string) =>
  renderToStaticMarkup(
    <ForwardCard
      m={msg(9, {
        content: 'secret words',
        author: user('carol'),
        forward: { author: user(author), created_at: 3, source_id: 5, origin: null, dropped: null },
      })}
      canDelete={false}
    />
  )

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setInitial = (part: Partial<typeof initial>) => Object.assign(initial, part)

const linkCard = (author: string) => {
  setInitial({
    linkCards: {
      5: {
        id: 5,
        server: 'rchat',
        channel_id: 1,
        dm_id: null,
        thread_root_id: null,
        author: user(author),
        created_at: 3,
        content: 'secret words',
        has_media: false,
        kind: 'user',
        forwarded: false,
      },
    },
  })
  return renderToStaticMarkup(
    <MessageLinkCard
      link={{
        kind: 'message',
        place: { kind: 'channel', server: 'rchat', channelId: 1 },
        thread: null,
        id: 5,
      }}
    />
  )
}

beforeEach(() => {
  setInitial({ me: me('alice'), guest: false, blocked: { bob: true } })
})

afterEach(() => {
  Object.assign(initial, saved)
})

describe('quotes of blocked users', () => {
  test('a forward of a blocked user collapses', () => {
    const html = forward('bob')
    expect(html).toContain('Blocked message')
    expect(html.includes('secret words')).toBe(false)
    expect(forward('dave')).toContain('secret words')
  })

  test('a message link card of a blocked user collapses', () => {
    const html = linkCard('bob')
    expect(html).toContain('Blocked message')
    expect(html.includes('secret words')).toBe(false)
    expect(linkCard('dave')).toContain('secret words')
  })
})
