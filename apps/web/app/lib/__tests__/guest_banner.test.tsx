import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageComposer } from '../../components/message_composer'
import { useStore } from '../store'

// A server render reads the store's initial state.
const initial = useStore.getInitialState()
const saved = { ...initial }
afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(saved)
})

// The classes of the guest notice and of the place it docks in.
const docked = (html: string) => {
  const m = /<div class="([^"]*)"><div data-guest-notice="[^"]*" class="([^"]*)">/.exec(html)
  return { dock: m?.[1].split(' ') ?? [], notice: m?.[2].split(' ') ?? [] }
}

describe('the guest banner', () => {
  test('keeps clear of the bottom safe area like the composer', () => {
    Object.assign(initial, {
      guest: true,
      view: { kind: 'channel', server: 'lounge', channelId: 1 },
    })
    const { dock, notice } = docked(renderToStaticMarkup(<MessageComposer />))
    expect(notice).not.toHaveLength(0)
    expect(dock).toContain('mb-[max(var(--space-md),env(safe-area-inset-bottom))]')
    expect(dock).toContain('keyboard:mb-(--space-md)')
    expect(notice.some(c => /^-?(m|mx|my|mt|mb)-/.test(c))).toBe(false)
  })
})
