import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageComposer } from '../../components/message_composer'
import { resetSessionCaches, useStore } from '../store'

afterAll(resetSessionCaches)

// A server render reads the store's initial state.
const initial = useStore.getInitialState()
const saved = { ...initial }
afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(saved)
})

// The classes of the guest notice.
const noticeClasses = (html: string) =>
  html.match(/<div data-guest-notice="[^"]*" class="([^"]*)">/)?.[1].split(' ') ?? []

describe('the guest banner', () => {
  test('keeps clear of the bottom safe area like the composer', () => {
    Object.assign(initial, {
      guest: true,
      view: { kind: 'channel', server: 'lounge', channelId: 1 },
    })
    const banner = noticeClasses(renderToStaticMarkup(<MessageComposer />))
    expect(banner).not.toHaveLength(0)
    expect(banner).toContain('mb-[max(0.75rem,env(safe-area-inset-bottom))]')
    expect(banner).toContain('keyboard:mb-3')
    expect(banner.some(c => /^(m|my|mb)-\d/.test(c))).toBe(false)
  })
})
