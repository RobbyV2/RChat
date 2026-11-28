import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dialog } from '../../components/ui'
import type { DialogFit } from '../dialog_size'
import { useStore } from '../store'
import { setLive } from '../motion/wire'

const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  setLive(null)
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

const render = (props: Omit<DialogFit, 'raised' | 'blur'> & { blurBackdrop?: boolean } = {}) =>
  renderToStaticMarkup(
    <Dialog title="Demo" onClose={() => {}} {...props}>
      <p data-body>Body</p>
    </Dialog>
  )

// The dialog slot as the engine reports it: playing, and with its backdrop blurring or not.
const playing = (blurs: boolean) => setLive(new Set(['dialog']), new Set(blurs ? ['dialog'] : []))

const backdropOf = (html: string) => /^<div class="([^"]*)"/.exec(html)?.[1].split(' ') ?? []

describe('Dialog', () => {
  test('the default chrome names the dialog by its heading and has a close button', () => {
    const html = render()
    expect(/role="dialog" aria-modal="true" aria-labelledby="[^"]+" tabindex="-1"/.test(html)).toBe(
      true
    )
    expect(html).toContain('outline-none')
    expect(html).toContain('>Demo</h2>')
    expect(html).toContain('title="Close" aria-label="Close"')
    expect(html).toContain('max-w-lg')
    expect(backdropOf(html)).toContain('z-page')
  })

  test('compact and full keep their boxes', () => {
    expect(render({ compact: true })).toContain('max-w-sm rounded-3xl')
    expect(backdropOf(render({ compact: true }))).toContain('z-top')
    expect(render({ full: true })).toContain('sm:max-w-lg')
    expect(render({ full: true })).toContain('sticky -top-6')
  })

  test('bare chrome leaves the header to the children and is named by the title', () => {
    const html = render({ size: 'settings', chrome: 'bare' })
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Demo" tabindex="-1"')
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('aria-label="Close"')
    expect(/tabindex="-1" class="[^"]*"><p data-body/.test(html)).toBe(true)
  })

  test('a large box with the default chrome keeps its header and puts the body in a column', () => {
    const html = render({ size: 'settings' })
    expect(html).toContain('md:w-[min(94vw,1120px)]')
    expect(html).toContain('<div class="mx-auto w-full max-w-3xl"><p data-body')
    expect(html).toContain('>Demo</h2>')
  })

  test('a custom box sets its lengths on the panel', () => {
    const html = render({ size: { width: 960, maxHeight: '80vh' } })
    expect(html).toContain('--dialog-w:960px')
    expect(html).toContain('--dialog-max-h:min(80vh, 100%)')
    expect(html).toContain('md:w-(--dialog-w)')
  })
})

// The classes of every element with a backdrop blur, and whether each is an empty layer.
const blurs = (html: string) =>
  [...html.matchAll(/<div([^>]*)class="([^"]*backdrop-blur[^"]*)"([^>]*)>(<\/div>)?/g)].map(m => ({
    classes: m[2].split(' ').filter(c => c.includes('blur')),
    layer: m[1].includes('aria-hidden="true"') && m[4] !== undefined,
  }))

describe('the backdrop blur', () => {
  const blurred = (html: string) => blurs(html).flatMap(b => b.classes)

  test('a large box blurs while animations play', () => {
    playing(true)
    expect(blurred(render({ size: 'settings' }))).toEqual(['md:backdrop-blur-[6px]'])
    expect(blurred(render({ size: 'settings', blurBackdrop: false }))).toEqual([])
    expect(blurred(render())).toEqual([])
    expect(blurred(render({ blurBackdrop: true }))).toEqual(['backdrop-blur-[6px]'])
  })

  test('the scrim stays plain while nothing plays or the tab runs late', () => {
    expect(blurred(render({ size: 'settings' }))).toEqual([])
    playing(false)
    expect(blurred(render({ size: 'settings' }))).toEqual([])
    expect(backdropOf(render({ size: 'settings' }))).toContain('bg-scrim/60')
  })

  test('the blur is an empty layer before the backdrop, so it holds no dialog', () => {
    playing(true)
    const html = render({ size: 'settings' })
    expect(blurs(html)).toEqual([{ classes: ['md:backdrop-blur-[6px]'], layer: true }])
    expect(html.indexOf('backdrop-blur')).toBeLessThan(html.indexOf('bg-scrim/60'))
  })

  test('a dialog inside a blurred large dialog has no blurred ancestor', () => {
    playing(true)
    const html = renderToStaticMarkup(
      <Dialog title="Outer" size="settings" chrome="bare" onClose={() => {}}>
        <Dialog title="Inner" compact blurBackdrop onClose={() => {}}>
          <p data-inner>Inner body</p>
        </Dialog>
      </Dialog>
    )
    expect(html).toContain('data-inner')
    expect(blurs(html).length).toBe(2)
    expect(blurs(html).every(b => b.layer)).toBe(true)
    expect(html.indexOf('aria-label="Outer"')).toBeLessThan(html.indexOf('data-inner'))
  })
})
