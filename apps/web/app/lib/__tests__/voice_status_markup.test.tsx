import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceStatusIcons } from '../../components/voice_status'
import { VOICE_STATUS_ON, type VoiceStatus } from '../voice_status'

const icons = (status: VoiceStatus, variant: 'row' | 'tile', self = false) =>
  renderToStaticMarkup(<VoiceStatusIcons status={status} self={self} size={14} variant={variant} />)

const named = (html: string) =>
  [...html.matchAll(/<span role="img" title="([^"]*)" aria-label="([^"]*)"/g)].map(m => [
    m[1],
    m[2],
  ])

describe('voice status icons', () => {
  test('each icon has a hover title and an accessible name, the mic first', () => {
    const deaf = icons({ mic: 'self', forced: null, deafened: true }, 'row')
    expect(named(deaf)).toEqual([
      ['Muted', 'Muted'],
      ['Deafened', 'Deafened'],
    ])
    expect(deaf).not.toContain('text-mute-fg')
    expect(deaf).toContain('text-on-surface-variant')
    expect(icons(VOICE_STATUS_ON, 'row')).toBe('')
  })

  test('a forced mute is red in rows and keeps its badge on tiles', () => {
    const timeout: VoiceStatus = { mic: 'forced', forced: 'timeout', deafened: false }
    const row = icons(timeout, 'row')
    expect(row).toContain('text-mute-fg')
    expect(named(row)).toEqual([['Muted by a moderator', 'Muted by a moderator']])
    expect(named(icons(timeout, 'row', true))[0]?.[0]).toBe('Muted while you are timed out')
    expect(icons(timeout, 'tile')).toContain('bg-mute p-0.5 text-on-mute')
    const plain = icons({ mic: 'self', forced: null, deafened: true }, 'tile')
    expect(plain).not.toContain('bg-mute')
    expect(named(plain)).toHaveLength(2)
  })
})
