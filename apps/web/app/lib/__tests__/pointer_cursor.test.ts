import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')

// The rule whose declarations set the pointer cursor.
const pointerRule = () => {
  const at = css.indexOf('cursor: pointer;')
  return at < 0 ? '' : css.slice(css.lastIndexOf('}', at) + 1, at)
}

describe('the pointer cursor', () => {
  test('one global rule gives every clickable control the hand', () => {
    const rule = pointerRule()
    for (const sel of [
      'button',
      "[role='button']",
      "[role='menuitem']",
      "[role='tab']",
      "[role='option']",
      "[role='switch']",
      'a[href]',
      'summary',
      'select',
      "label:has(input:is([type='checkbox'], [type='radio']):enabled)",
    ])
      expect(rule).toContain(sel)
  })

  test('the label of a disabled checkbox or radio keeps the default cursor', () => {
    const labels = pointerRule().match(/label:has\([^\n]*\)/g) ?? []
    expect(labels.length > 0).toBe(true)
    for (const l of labels) expect(l).toContain(':enabled')
  })

  test('disabled controls keep the default cursor', () => {
    expect(pointerRule()).toContain(":not(:disabled, [aria-disabled='true'])")
  })
})
