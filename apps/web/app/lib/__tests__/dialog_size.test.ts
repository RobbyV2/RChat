import { describe, expect, test } from 'bun:test'
import {
  boxVars,
  dialogBlurs,
  dialogLayout,
  largeDialog,
  type DialogFit,
  type DialogSize,
} from '../dialog_size'

const classes = (text: string) => text.split(/\s+/).filter(Boolean)
const has = (text: string, ...wanted: string[]) => {
  const all = classes(text)
  for (const c of wanted) expect(all).toContain(c)
}
const lacks = (text: string, ...unwanted: string[]) => {
  const all = classes(text)
  for (const c of unwanted) expect(all).not.toContain(c)
}

// The classes that apply below a breakpoint: those without a prefix.
const phone = (text: string) => classes(text).filter(c => !/^(sm|md|lg|xl):/.test(c))

describe('named sizes', () => {
  test('without a size the dialog is the medium card', () => {
    const fit = dialogLayout({})
    has(fit.panel, 'max-w-lg', 'rounded-2xl', 'max-h-[min(85vh,100%)]', 'p-6', 'overflow-y-auto')
    has(fit.backdrop, 'z-40', 'px-safe-4', 'py-4', 'bg-scrim/60')
    has(fit.header, 'mb-4')
    lacks(fit.header, 'sticky')
    expect(fit.style).toBeUndefined()
    expect(dialogLayout({ size: 'md' })).toEqual(fit)
  })

  test('compact is the small card and sits above other dialogs', () => {
    const fit = dialogLayout({ compact: true })
    has(fit.panel, 'max-w-sm', 'rounded-3xl', 'max-h-full')
    has(fit.backdrop, 'z-50')
    expect(dialogLayout({ size: 'sm' }).panel).toBe(fit.panel)
    has(dialogLayout({ size: 'sm' }).backdrop, 'z-40')
  })

  test('lg and xl are wider cards', () => {
    has(dialogLayout({ size: 'lg' }).panel, 'max-w-2xl', 'rounded-2xl')
    has(dialogLayout({ size: 'xl' }).panel, 'max-w-4xl', 'rounded-2xl')
    lacks(dialogLayout({ size: 'xl' }).panel, 'h-full')
  })

  test('full fills phones with a sticky header and is the medium card from sm up', () => {
    const fit = dialogLayout({ full: true })
    has(
      fit.panel,
      'h-full',
      'max-h-none',
      'pb-[max(1.5rem,env(safe-area-inset-bottom))]',
      'sm:h-auto',
      'sm:pb-6',
      'sm:max-w-lg',
      'sm:rounded-2xl',
      'sm:max-h-[min(85vh,100%)]'
    )
    has(fit.backdrop, 'px-safe', 'sm:px-safe-4', 'sm:py-4')
    has(fit.header, 'sticky', '-top-6', 'bg-surface-container-high')
    lacks(fit.header, 'border-b')
    has(dialogLayout({ full: true, size: 'lg' }).panel, 'h-full', 'sm:max-w-2xl')
  })

  test('settings and full are large boxes from md up', () => {
    const settings = dialogLayout({ size: 'settings' })
    has(settings.panel, 'md:w-[min(94vw,1120px)]', 'md:h-[min(88dvh,820px)]', 'md:rounded-2xl')
    has(settings.panel, 'md:max-w-full', 'md:max-h-full', 'md:border')
    has(settings.backdrop, 'md:px-safe-4', 'md:py-4')
    has(settings.header, 'sticky', 'border-b')
    has(dialogLayout({ size: 'full' }).panel, 'md:w-[min(96vw,1400px)]', 'md:h-[min(92dvh,960px)]')
  })

  test('a size wins over the full and compact switches for the box', () => {
    has(dialogLayout({ size: 'settings', full: true }).panel, 'md:w-[min(94vw,1120px)]')
    const fit = dialogLayout({ size: 'xl', compact: true })
    has(fit.panel, 'max-w-4xl')
    has(fit.backdrop, 'z-50')
  })
})

describe('large boxes on phones', () => {
  const LARGE: DialogSize[] = ['settings', 'full', { width: 960, height: '70vh' }]

  test('fill the screen edge to edge, inside the safe areas, and never get wider', () => {
    for (const size of LARGE)
      for (const chrome of ['default', 'bare'] as const) {
        const fit = dialogLayout({ size, chrome })
        const panel = phone(fit.panel)
        expect(panel).toContain('w-full')
        expect(panel).toContain('h-full')
        expect(panel.filter(c => /^(min-|max-)?w-/.test(c))).toEqual(['w-full'])
        const around = phone(fit.backdrop).filter(c => /^p[xy]?-/.test(c))
        expect(around).toEqual(chrome === 'default' ? ['px-safe'] : [])
        if (chrome === 'bare') expect(panel).toContain('px-safe')
      }
  })

  test('keep the home indicator clear: the default chrome pads the bottom', () => {
    has(dialogLayout({ size: 'settings' }).panel, 'pb-[max(1.5rem,env(safe-area-inset-bottom))]')
  })
})

describe('chrome', () => {
  test('bare leaves padding and scrolling to the content', () => {
    const fit = dialogLayout({ size: 'settings', chrome: 'bare' })
    has(fit.panel, 'flex', 'flex-col', 'overflow-hidden', 'bg-surface', 'px-safe', 'md:px-0')
    lacks(fit.panel, 'p-6', 'overflow-y-auto', 'bg-surface-container-high')
  })

  test('a large box with the default chrome keeps its children in a readable column', () => {
    expect(dialogLayout({ size: 'settings' }).body).toBe('mx-auto w-full max-w-3xl')
    expect(dialogLayout({ size: { width: 900 } }).body).toBe('mx-auto w-full max-w-3xl')
    expect(dialogLayout({ size: 'settings', chrome: 'bare' }).body).toBeUndefined()
    expect(dialogLayout({ full: true }).body).toBeUndefined()
    expect(dialogLayout({ size: 'xl' }).body).toBeUndefined()
  })

  test('raised sits above other dialogs and full pages', () => {
    has(dialogLayout({ size: 'settings', raised: true }).backdrop, 'z-50')
    has(dialogLayout({ size: 'settings' }).backdrop, 'z-40')
  })
})

describe('custom boxes', () => {
  test('take CSS lengths, pixels for numbers, clamped to the room the backdrop leaves', () => {
    expect(boxVars({ width: 960, maxHeight: '80vh' })).toEqual({
      '--dialog-w': '960px',
      '--dialog-max-w': 'min(100%, 100%)',
      '--dialog-h': 'auto',
      '--dialog-max-h': 'min(80vh, 100%)',
    })
    expect(boxVars({ maxWidth: 'min(90vw, 1000px)', height: 600 })).toEqual({
      '--dialog-w': '100%',
      '--dialog-max-w': 'min(min(90vw, 1000px), 100%)',
      '--dialog-h': '600px',
      '--dialog-max-h': 'min(100%, 100%)',
    })
  })

  test('apply their variables from md up', () => {
    const fit = dialogLayout({ size: { width: 960 } })
    expect(fit.style).toEqual(boxVars({ width: 960 }))
    has(fit.panel, 'md:w-(--dialog-w)', 'md:max-w-(--dialog-max-w)', 'md:h-(--dialog-h)')
    has(fit.panel, 'md:max-h-(--dialog-max-h)')
  })
})

describe('backdrop blur', () => {
  test('large boxes blur only while motion plays', () => {
    expect(dialogBlurs('settings', undefined, true)).toBe(true)
    expect(dialogBlurs({ width: 900 }, undefined, true)).toBe(true)
    expect(dialogBlurs('settings', undefined, false)).toBe(false)
    expect(dialogBlurs('settings', false, true)).toBe(false)
  })

  test('cards blur only when asked, and never without motion', () => {
    expect(dialogBlurs(undefined, undefined, true)).toBe(false)
    expect(dialogBlurs('lg', undefined, true)).toBe(false)
    expect(dialogBlurs('md', true, true)).toBe(true)
    expect(dialogBlurs('md', true, false)).toBe(false)
  })

  test('the blur is a layer beside the backdrop, from the breakpoint where the scrim shows', () => {
    const blurred = (fit: DialogFit) =>
      classes(dialogLayout(fit).blur ?? '').filter(c => /blur/.test(c))
    expect(blurred({ size: 'settings', blur: true })).toEqual(['md:backdrop-blur-[6px]'])
    expect(blurred({ full: true, blur: true })).toEqual(['sm:backdrop-blur-[6px]'])
    expect(blurred({ blur: true })).toEqual(['backdrop-blur-[6px]'])
    expect(dialogLayout({ size: 'settings' }).blur).toBeUndefined()
    for (const fit of [{ size: 'settings' }, { full: true }, {}] as DialogFit[])
      expect(dialogLayout({ ...fit, blur: true }).backdrop.includes('blur')).toBe(false)
    has(dialogLayout({ size: 'settings', blur: true }).backdrop, 'bg-scrim/60')
  })

  test('the blur layer covers what the backdrop covers, under it, and lets clicks through', () => {
    for (const fit of [
      { size: 'settings' },
      { compact: true },
      { size: 'xl', raised: true },
    ] as DialogFit[]) {
      const layout = dialogLayout({ ...fit, blur: true })
      const layer = classes(layout.blur ?? '')
      has(layout.blur ?? '', 'fixed', 'inset-x-0', 'top-app', 'h-app', 'pointer-events-none')
      const z = classes(layout.backdrop).find(c => c.startsWith('z-'))
      expect(layer.find(c => c.startsWith('z-'))).toBe(z)
    }
  })

  test('large sizes are settings, full and custom boxes', () => {
    expect(largeDialog('settings')).toBe(true)
    expect(largeDialog('full')).toBe(true)
    expect(largeDialog({ width: 300 })).toBe(true)
    for (const size of ['sm', 'md', 'lg', 'xl', undefined] as const)
      expect(largeDialog(size)).toBe(false)
  })
})
