import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelEnd, TypingEllipsis } from '../../components/typing_indicator'
import { useStore } from '../store'

// Markup renders with the store's initial state.
const initial = useStore.getInitialState()
const before = { anim: initial.anim, streamer: initial.streamer }
afterEach(() => {
  initial.anim = before.anim
  initial.streamer = before.streamer
})

describe('typing dots on rows', () => {
  test('do not move with animations off, and bounce with them on', () => {
    const still = renderToStaticMarkup(<TypingEllipsis names={['Alice']} />)
    expect(still).toContain('aria-label="Alice is typing"')
    expect(still).toContain('title="Alice is typing"')
    expect(still).not.toContain('animate-typing-dot')
    initial.anim = { on: true, motion: 'always' }
    expect(renderToStaticMarkup(<TypingEllipsis names={['Alice']} />)).toContain(
      'animate-typing-dot'
    )
  })

  test('hide names in streamer mode', () => {
    initial.streamer = true
    const html = renderToStaticMarkup(<TypingEllipsis names={['Alice', 'Bob']} />)
    expect(html).toContain('aria-label="2 people are typing"')
    expect(html).not.toContain('Alice')
  })

  test('take the unread dot place, and come before a ping count', () => {
    const end = (typers: string[], pings: number, unread: boolean) =>
      renderToStaticMarkup(<ChannelEnd typers={typers} pings={pings} unread={unread} />)
    expect(end([], 0, false)).toBe('')
    expect(end([], 0, true)).toContain('title="Unread"')
    expect(end([], 2, true)).toContain('data-ping-badge="2"')
    const typing = end(['Bob'], 0, true)
    expect(typing).toContain('data-typing-dots')
    expect(typing).not.toContain('title="Unread"')
    const both = end(['Bob'], 3, true)
    expect(both.indexOf('data-typing-dots')).toBeLessThan(both.indexOf('data-ping-badge="3"'))
  })
})
