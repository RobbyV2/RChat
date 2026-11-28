import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Loaded } from '../../components/loaded'
import { emojiData, emojiSource, emojiWatch, loadEmojiData } from '../emoji'
import { setTime } from '../platform/time'
import { ManualTime } from './helpers/test_clock'

afterEach(() => setTime())

const draw = () =>
  renderToStaticMarkup(
    <Loaded load={emojiSource().get()} what="emoji">
      {data => <b>{data.length > 100 ? 'emoji' : 'few'}</b>}
    </Loaded>
  )

describe('the emoji data as a load', () => {
  test('is asked for once it is watched, and drawn when it is here', async () => {
    setTime(new ManualTime())
    const source = emojiSource()
    expect(source.get().status).toBe('loading')
    expect(draw()).toContain('aria-label="Loading emoji"')
    const stop = source.subscribe(() => {})
    await loadEmojiData()
    await Promise.resolve()
    expect(source.get().status).toBe('ready')
    expect(draw()).toBe('<b>emoji</b>')
    stop()
  })

  test('is one load for every screen', () => {
    expect(emojiSource()).toBe(emojiSource())
  })

  test('watching for it asks only when it is wanted', async () => {
    setTime(new ManualTime())
    const idle = emojiWatch(false)
    expect(idle.get()).toBe(null)
    idle.subscribe(() => {})()
    expect(emojiWatch(true)).toBe(emojiSource())
    await loadEmojiData()
    expect((emojiData() ?? []).length).toBeGreaterThan(100)
  })
})
