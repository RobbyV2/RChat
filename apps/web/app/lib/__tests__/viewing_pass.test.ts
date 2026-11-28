import { afterEach, describe, expect, test } from 'bun:test'
import { createViewing, ViewPass, type ViewingTarget } from '../viewing'
import { memoryStorage } from './fixtures'

const place = { origin: 'https://chat.example', scoped: (key: string) => key }
const marked: ViewingTarget = {
  kind: 'channel',
  key: 'rchat_viewing_v1:m',
  name: 'm',
  sensitive: true,
}
const plain: ViewingTarget = {
  kind: 'channel',
  key: 'rchat_viewing_v1:p',
  name: 'p',
  sensitive: false,
}
const app: ViewingTarget = { kind: 'app', key: 'rchat_viewing_v1:a', name: 'a', sensitive: false }

afterEach(() => memoryStorage.clear())

describe('consent to view', () => {
  test('is a pass that only the consent gives', () => {
    const viewing = createViewing(place)
    expect(viewing.canView(plain) instanceof ViewPass).toBe(true)
    expect(viewing.canView(plain)?.target).toBe(plain.key)
    expect(viewing.canView(marked)).toBeNull()
    expect(viewing.canView(app)).toBeNull()
    const forged = ViewPass as unknown as new (key: symbol, target: string) => ViewPass
    expect(() => new forged(Symbol('view pass'), marked.key)).toThrow()
  })

  test('a marked target gives a pass only once its prompt is answered with open', async () => {
    const viewing = createViewing(place)
    const host = viewing.registerPromptHost()!
    const refused = viewing.requestViewing(marked)
    host.answer(viewing.useViewing.getState().prompt!, false, false)
    expect(await refused).toBeNull()
    expect(viewing.canView(marked)).toBeNull()
    const opened = viewing.requestViewing(marked)
    host.answer(viewing.useViewing.getState().prompt!, true, false)
    expect((await opened)?.target).toBe(marked.key)
    expect(viewing.canView(marked) instanceof ViewPass).toBe(true)
    viewing.leaveVisit()
    expect(viewing.canView(marked)).toBeNull()
  })

  test('a remembered choice gives a pass again after the page loads anew', async () => {
    const first = createViewing(place)
    const host = first.registerPromptHost()!
    const opened = first.requestViewing(marked)
    host.answer(first.useViewing.getState().prompt!, true, true)
    await opened
    const again = createViewing(place)
    expect(again.canView(marked) instanceof ViewPass).toBe(true)
    again.forgetViewing(marked)
    expect(createViewing(place).canView(marked)).toBeNull()
  })

  test('what the store shows of a prompt cannot answer it', async () => {
    const viewing = createViewing(place)
    const asked = viewing.requestViewing(marked)
    const shown = viewing.useViewing.getState().prompt!
    expect(Object.keys(shown)).toEqual(['target'])
    expect(Object.values(viewing.useViewing.getState()).some(v => typeof v === 'function')).toBe(
      false
    )
    expect(viewing.canView(marked)).toBeNull()
    // Anyone may turn a prompt down; that opens nothing.
    viewing.cancelViewing()
    expect(await asked).toBeNull()
  })

  test('the prompt has one host at a time, and an answer reaches only the prompt it was for', async () => {
    const viewing = createViewing(place)
    const host = viewing.registerPromptHost()!
    expect(viewing.registerPromptHost()).toBeNull()
    const first = viewing.requestViewing(marked)
    const stale = viewing.useViewing.getState().prompt!
    const second = viewing.requestViewing(app)
    expect(await first).toBeNull()
    host.answer(stale, true, true)
    expect(viewing.canView(marked)).toBeNull()
    expect(viewing.useViewing.getState().prompt?.target).toBe(app)
    host.release()
    host.answer(viewing.useViewing.getState().prompt!, true, false)
    expect(viewing.canView(app)).toBeNull()
    const next = viewing.registerPromptHost()!
    next.answer(viewing.useViewing.getState().prompt!, true, false)
    expect((await second)?.target).toBe(app.key)
  })
})
