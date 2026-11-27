import { expect, test } from 'bun:test'
import { showsDeviceKey } from '../device_key'

test('the device key section shows where this device encrypted something, or replaces its key', () => {
  expect(showsDeviceKey({ sealedAny: false, replacing: false })).toBe(false)
  expect(showsDeviceKey({ sealedAny: true, replacing: false })).toBe(true)
  expect(showsDeviceKey({ sealedAny: false, replacing: true })).toBe(true)
})
