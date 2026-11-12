import { describe, expect, test } from 'bun:test'
import {
  choiceOf,
  optionOf,
  publicReadingAllowed,
  readableNow,
  readingChoices,
  readingLine,
  shownChoice,
  siteDefault,
} from '../public_reading'
import type { ServerJoining } from '../types'

const site = (
  server_joining: ServerJoining | undefined,
  public_reading: boolean | undefined = true,
  guests_enabled = true
) => ({ server_joining, public_reading, guests_enabled })

const JOINING: ServerJoining[] = ['everyone', 'invites', 'nobody']

describe('readableNow', () => {
  test('following the site, only a server anyone can join by name is readable', () => {
    expect(readableNow(null, false, site('everyone'))).toBe(true)
    expect(readableNow(null, true, site('everyone'))).toBe(false)
    for (const joining of ['invites', 'nobody'] as const) {
      expect(readableNow(null, false, site(joining))).toBe(false)
      expect(readableNow(null, true, site(joining))).toBe(false)
    }
  })

  test('an owner who set it by hand wins over the joining switch', () => {
    for (const joining of JOINING) {
      for (const hasPassword of [false, true]) {
        expect(readableNow(true, hasPassword, site(joining))).toBe(true)
        expect(readableNow(false, hasPassword, site(joining))).toBe(false)
      }
    }
  })

  test('the site turning public reading off wins over everything', () => {
    for (const joining of JOINING) {
      for (const option of [null, true, false]) {
        for (const hasPassword of [false, true]) {
          expect(readableNow(option, hasPassword, site(joining, false))).toBe(false)
        }
      }
    }
    expect(publicReadingAllowed(site('everyone', false))).toBe(false)
  })

  test('an older instance without the settings reads as today', () => {
    const older = site(undefined, undefined)
    expect(publicReadingAllowed(older)).toBe(true)
    expect(siteDefault(false, older)).toBe(true)
    expect(readableNow(null, false, older)).toBe(true)
    expect(readableNow(null, true, older)).toBe(false)
  })
})

describe('readingLine', () => {
  test('says who can read and whether they can join', () => {
    expect(readingLine(null, false, site('everyone'))).toBe(
      "People who aren't members can read it and talk in voice."
    )
    expect(readingLine(true, true, site('everyone'))).toBe(
      "People who aren't members can read it and talk in voice. New people need a password."
    )
    expect(readingLine(true, false, site('invites'))).toBe(
      "People who aren't members can read it and talk in voice. New people need a password or invite."
    )
    expect(readingLine(true, false, site('nobody'))).toBe(
      "People who aren't members can read it and talk in voice. Nobody new can join."
    )
    expect(readingLine(true, true, site('nobody'))).toBe(
      "People who aren't members can read it and talk in voice. Nobody new can join."
    )
  })

  test('says when only members read it', () => {
    expect(readingLine(false, false, site('everyone'))).toBe('Only members can read this server.')
    expect(readingLine(null, false, site('invites'))).toBe('Only members can read this server.')
    expect(readingLine(null, true, site('everyone'))).toBe('Only members can read this server.')
  })

  test('says when the site turned it off, whatever the option is', () => {
    for (const option of [null, true, false]) {
      expect(readingLine(option, false, site('everyone', false))).toBe(
        'Public reading is turned off on this site.'
      )
    }
  })

  test('names accounts when guests are off', () => {
    expect(readingLine(true, false, site('everyone', true, false))).toBe(
      "People with an account who aren't members can read it and talk in voice."
    )
  })

  test('is short, plain copy', () => {
    for (const joining of JOINING) {
      for (const option of [null, true, false]) {
        for (const hasPassword of [false, true]) {
          for (const allowed of [true, false]) {
            const line = readingLine(option, hasPassword, site(joining, allowed))
            expect(/[\u2013\u2014]|RChat/.test(line)).toBe(false)
            expect(line.length).toBeLessThan(120)
          }
        }
      }
    }
  })
})

describe('readingChoices', () => {
  test('are the three stored states, with what the site default is now', () => {
    const open = readingChoices(false, site('everyone'))
    expect(open.map(c => c.value)).toEqual(['default', 'on', 'off'])
    expect(open.map(c => c.label)).toEqual(['Site default (on)', 'On', 'Off'])
    expect(readingChoices(false, site('invites'))[0].label).toBe('Site default (off)')
    expect(readingChoices(true, site('everyone'))[0].label).toBe('Site default (off)')
  })

  test('map to the stored option and back', () => {
    for (const option of [null, true, false]) expect(optionOf(choiceOf(option))).toBe(option)
    expect([choiceOf(null), choiceOf(true), choiceOf(false)]).toEqual(['default', 'on', 'off'])
  })

  test('show off while the site turned public reading off', () => {
    for (const option of [null, true, false]) {
      expect(shownChoice(option, site('everyone', false))).toBe('off')
      expect(shownChoice(option, site('everyone'))).toBe(choiceOf(option))
    }
  })
})
