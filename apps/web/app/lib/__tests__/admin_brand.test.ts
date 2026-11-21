import { expect, test } from 'bun:test'
import {
  BRAND_ROWS,
  brandRow,
  linksError,
  linksOf,
  suggestionsError,
  suggestionsOf,
  textError,
} from '../admin_brand'
import { patchFor } from '../admin_config'

const text = (key: string) => {
  const row = brandRow(key)
  if (row?.kind !== 'text') throw new Error(`${key} is a text`)
  return row
}

test('every row has a label and a plain line', () => {
  for (const row of BRAND_ROWS) {
    expect(row.label.length).toBeGreaterThan(0)
    expect(row.line.endsWith('.')).toBe(true)
    expect(/[—–]/.test(row.label + row.line)).toBe(false)
    expect(/rchat/i.test(row.label + row.line)).toBe(false)
  }
})

test('texts keep to their lengths, counted in characters', () => {
  const name = text('instance_name')
  expect(textError(name, 'Example Chat')).toBeNull()
  expect(textError(name, '   ')).toBe('Enter a name.')
  expect(textError(name, 'x'.repeat(64))).toBeNull()
  expect(textError(name, 'x'.repeat(65))).toBe('Use at most 64 characters.')
  expect(textError(name, '😀'.repeat(64))).toBeNull()
  expect(textError(name, 'two\nlines')).toBe('Use one line of text.')
  expect(textError(text('app_name'), '')).toBeNull()
  expect(textError(text('app_short_name'), 'x'.repeat(17))).toBe('Use at most 16 characters.')
  const about = text('brand_about')
  expect(textError(about, 'Run by us.\r\nBe kind.')).toBeNull()
  expect(textError(about, 'x'.repeat(1001))).toBe('Use at most 1000 characters.')
  expect(textError(about, 'bell\u0007')).toBe('Use plain text.')
  expect(textError(text('login_note'), 'x'.repeat(301))).toBe('Use at most 300 characters.')
})

test('links need a label and an https address', () => {
  const ok = { label: 'Help', url: 'https://help.example.com' }
  expect(linksError([])).toBeNull()
  expect(linksError([ok, ok, ok, ok])).toBeNull()
  expect(linksError([ok, ok, ok, ok, ok])).toBe('Use at most 4 links.')
  expect(linksError([{ ...ok, label: ' ' }])).toBe('Give each link a label.')
  expect(linksError([{ ...ok, label: 'x'.repeat(33) }])).toBe(
    'Use at most 32 characters in a label.'
  )
  for (const url of [
    'http://help.example.com',
    'javascript:alert(1)',
    'help.example.com',
    'https://user:pw@example.com',
    '',
  ])
    expect(linksError([{ ...ok, url }])).toBe(
      'Each link needs an address that starts with https://.'
    )
})

test('suggested instances need an address', () => {
  const ok = { url: 'https://chat.example.com', label: '' }
  expect(suggestionsError([ok, { url: 'http://10.0.0.5:3000', label: 'Office' }])).toBeNull()
  expect(suggestionsError(Array(21).fill(ok))).toBe('Use at most 20 instances.')
  expect(suggestionsError([{ ...ok, label: 'x'.repeat(33) }])).toBe(
    'Use at most 32 characters in a label.'
  )
  expect(suggestionsError([{ ...ok, url: 'chat.example.com' }])).toBe(
    'Each instance needs an address that starts with https:// or http://.'
  )
})

test('stored values are read defensively', () => {
  expect(linksOf('[{"label":"Help","url":"https://h.example/"},{"label":1},7]')).toEqual([
    { label: 'Help', url: 'https://h.example/' },
  ])
  expect(linksOf('{')).toEqual([])
  expect(linksOf(null)).toEqual([])
  expect(linksOf('{"label":"x"}')).toEqual([])
  expect(
    suggestionsOf('{"mode":"replace","list":[{"url":"https://a.example","label":"A"},{"url":3}]}')
  ).toEqual({ mode: 'replace', list: [{ url: 'https://a.example', label: 'A' }] })
  expect(suggestionsOf('{"mode":"only","list":[{"url":"https://a.example"}]}')).toEqual({
    mode: 'add',
    list: [{ url: 'https://a.example', label: '' }],
  })
  expect(suggestionsOf('nope')).toEqual({ mode: 'add', list: [] })
  expect(suggestionsOf(undefined)).toEqual({ mode: 'add', list: [] })
})

test('the config view sets a brand control the way the settings take it', () => {
  expect(patchFor('instance_name', 'Example Chat')).toEqual({ instance_name: 'Example Chat' })
  expect(patchFor('app_name', 'on')).toEqual({ app_name: 'on' })
  expect(patchFor('brand_about', '')).toEqual({ brand_about: '' })
  expect(patchFor('brand_links', '[{"label":"Help","url":"https://h.example/"}]')).toEqual({
    brand_links: [{ label: 'Help', url: 'https://h.example/' }],
  })
  expect(patchFor('instance_suggestions', '{"mode":"replace","list":[]}')).toEqual({
    instance_suggestions: { mode: 'replace', list: [] },
  })
})
