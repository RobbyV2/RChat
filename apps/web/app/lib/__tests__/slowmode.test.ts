import { describe, expect, test } from 'bun:test'
import {
  SLOWMODE_PRESETS,
  clock,
  customSeconds,
  isPreset,
  slowExempt,
  slowLabel,
  slowTitle,
  slowWait,
} from '../slowmode'
import { Perm } from '../types'

describe('slow mode', () => {
  test('presets match the channel settings list', () => {
    expect(SLOWMODE_PRESETS.map(slowLabel)).toEqual([
      'Off',
      '5s',
      '10s',
      '15s',
      '30s',
      '1m',
      '2m',
      '5m',
      '10m',
      '15m',
      '30m',
      '1h',
      '2h',
      '6h',
    ])
    expect(isPreset(30)).toBe(true)
    expect(isPreset(45)).toBe(false)
  })

  test('labels and the header tooltip', () => {
    expect(slowLabel(90)).toBe('1m 30s')
    expect(slowLabel(3725)).toBe('1h 2m 5s')
    expect(slowTitle(30)).toBe('Slow mode is on: 30s')
  })

  test('custom seconds are whole numbers from 1 to 21600', () => {
    expect(customSeconds(' 45 ')).toBe(45)
    expect(customSeconds('1')).toBe(1)
    expect(customSeconds('21600')).toBe(21600)
    for (const bad of ['0', '21601', '-5', '1.5', '', 'abc']) expect(customSeconds(bad)).toBeNull()
  })

  test('the server wait message', () => {
    expect(slowWait('Slow mode: wait 12s')).toBe(12)
    expect(slowWait('Too many requests')).toBeNull()
  })

  test('managers and message managers are exempt', () => {
    expect(slowExempt(Perm.ManageChannels)).toBe(true)
    expect(slowExempt(Perm.DeleteMessages)).toBe(true)
    expect(slowExempt(Perm.Kick)).toBe(false)
    expect(slowExempt(0)).toBe(false)
  })

  test('countdown clock', () => {
    expect(clock(12_000)).toBe('0:12')
    expect(clock(11_001)).toBe('0:12')
    expect(clock(75_000)).toBe('1:15')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-5)).toBe('0:00')
  })
})
