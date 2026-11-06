import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { resetSessionCaches, useStore } from '../store'
import type { Registration } from '../types'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const settings = st().settings

afterEach(() => useStore.setState({ me: null, guest: false, error: null, settings }))

describe('guest prompts', () => {
  const cases: [Registration, string][] = [
    ['open', 'Create an account'],
    ['closed', 'Log in'],
  ]
  for (const [registration, ask] of cases)
    test(`say ${ask} while new accounts are ${registration}`, async () => {
      useStore.setState({
        me: null,
        guest: true,
        error: null,
        settings: { ...settings, registration },
      })
      await st().joinVoice('s', 5)
      expect(st().error).toBe(`${ask} to join voice`)
      await st().startCall(3, false)
      expect(st().error).toBe(`${ask} to start calls`)
      await st().messageUser('bob', 'hi')
      expect(st().error).toBe(`${ask} to send messages`)
      expect(await st().setBio('hi')).toBe(`${ask} to add a description`)
    })
})
