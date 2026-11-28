import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScheduledChip, ScheduledList, SendButton } from '../../components/scheduled'
import type { ScheduledItem, ScheduledOps } from '../scheduled'
import { resetSessionCaches } from '../store'

afterAll(resetSessionCaches)

const ops: ScheduledOps = {
  side: 'hosted',
  max: 4000,
  edit: async () => null,
  removeReply: async () => null,
  reschedule: async () => null,
  sendNow: async () => null,
  resume: async () => null,
  remove: async () => null,
}

const item = (over: Partial<ScheduledItem>): ScheduledItem => ({
  key: 'h:1',
  side: 'hosted',
  place: 'c1',
  body: 'see you **soon**',
  reply: null,
  at: Date.now() + 3_600_000,
  next: Date.now() + 3_600_000,
  state: 'waiting',
  error: null,
  deferred: false,
  label: { server: 'Pixel Club', channel: 'general', person: null, by: null, thread: false },
  ...over,
})

const labelled = (html: string, label: string) =>
  html.includes(`title="${label}" aria-label="${label}"`)

describe('scheduled markup', () => {
  test('the Send button keeps its name and says it has a menu', () => {
    const html = renderToStaticMarkup(
      <SendButton title="Send" disabled={false} onSend={() => {}} draft={() => null} />
    )
    expect(html).toContain('aria-label="Send"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('data-long-press')
    const off = renderToStaticMarkup(
      <SendButton title="Message is too long" disabled onSend={() => {}} draft={() => null} />
    )
    expect(off).not.toContain('disabled=""')
    expect(off).toContain('aria-disabled="true"')
    expect(off).toContain('data-long-press')
    expect(off).toContain('title="Message is too long"')
  })

  test('list rows label every button and name their place', () => {
    const html = renderToStaticMarkup(
      <ScheduledList
        showPlace
        ops={ops}
        items={[
          item({}),
          item({ key: 'h:2', state: 'failed', error: 'Gone', label: null }),
          item({ key: 'h:4', state: 'paused' }),
          item({
            key: 'd:3',
            side: 'device',
            label: { server: null, channel: null, person: 'Bob', by: 'ik', thread: false },
          }),
        ]}
      />
    )
    for (const label of ['Edit', 'Send now', 'Retry', 'Resume', 'Reschedule', 'Delete'])
      expect([label, labelled(html, label)]).toEqual([label, true])
    expect(html).toContain('see you soon')
    expect(html).toContain('Not sent: Gone')
    expect(html).toContain('Paused when you were signed out everywhere')
    expect(html).toContain('Somewhere you can&#x27;t open now')
    expect(html).toContain('general')
    expect(html.match(/class="streamer"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html.indexOf('data-scheduled-row="h:2"')).toBeLessThan(
      html.indexOf('data-scheduled-row="h:1"')
    )
  })

  test('an empty list says how to schedule', () => {
    const html = renderToStaticMarkup(<ScheduledList items={[]} ops={ops} />)
    expect(html).toContain('Nothing scheduled')
    expect(html).toContain('Right-click or long-press Send to send a message later.')
  })

  test('the chip counts its place only', () => {
    const items = [
      item({}),
      item({ key: 'h:2', state: 'failed' }),
      item({ key: 'h:3', place: 'c2' }),
    ]
    const html = renderToStaticMarkup(<ScheduledChip place="c1" items={items} ops={ops} />)
    expect(html).toContain('1 scheduled, 1 not sent')
    expect(html).toContain('title="2 scheduled messages here"')
    expect(html).toContain('text-error')
    expect(renderToStaticMarkup(<ScheduledChip place="c9" items={items} ops={ops} />)).toBe('')
  })
})
