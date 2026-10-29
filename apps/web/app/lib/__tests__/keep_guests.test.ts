import { describe, expect, test } from 'bun:test'
import { WITH_OPTION, keepGuestsChoices } from '../../components/server_settings'
import { passwordPrompt } from '../rules'

describe('keep guest access option', () => {
  test('only a password change offers it, under Keep everyone', () => {
    const change = keepGuestsChoices(passwordPrompt(true, 'new', true, false).choices, true)
    expect(change.map(c => [c.value, c.option?.label ?? null])).toEqual([
      ['keep', 'Also keep guest access'],
      ['remove', null],
    ])
    expect(change[0]?.detail).toContain('lose access')
    for (const [had, next] of [
      [false, 'new'],
      [true, ''],
    ] as const) {
      const prompt = passwordPrompt(had, next, true, false)
      const choices = keepGuestsChoices(prompt.choices, had && next !== '')
      expect(choices.every(c => c.option === undefined)).toBe(true)
    }
    expect(`keep${WITH_OPTION}`).toBe('keep+option')
  })
})
