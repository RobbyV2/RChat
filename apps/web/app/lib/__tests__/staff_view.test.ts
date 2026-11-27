import { expect, test } from 'bun:test'
import { ApiError } from '../api'
import {
  STAFF_REASON_MAX,
  asksStaffView,
  staffAsked,
  staffChange,
  staffEnded,
  staffOpened,
  staffReasonHeader,
  staffViewChannel,
} from '../staff_view'
import type { View } from '../view'
import { me } from './fixtures'

const refusal = (status: number, reason?: Record<string, unknown>) =>
  new ApiError('Confirm to open this channel', status, {
    error: 'Confirm to open this channel',
    ...(reason ? { reason } : {}),
  })

const confirm = { kind: 'confirm', control: 'staff_view', channel: 7 }

test('only the 403 that asks to confirm a channel names it', () => {
  expect(staffViewChannel(refusal(403, confirm))).toBe(7)
  expect(asksStaffView(refusal(403, confirm))).toBe(true)
  for (const other of [
    refusal(403),
    refusal(403, { ...confirm, kind: 'limit' }),
    refusal(403, { ...confirm, control: 'server_search' }),
    refusal(403, { kind: 'confirm', control: 'staff_view' }),
    refusal(404, confirm),
    new ApiError('Banned', 403),
    new Error('Confirm to open this channel'),
  ]) {
    expect(staffViewChannel(other)).toBeNull()
    expect(asksStaffView(other)).toBe(false)
  }
})

test('a reason is trimmed, cut to the limit and percent-encoded', () => {
  expect(staffReasonHeader('')).toBeNull()
  expect(staffReasonHeader('   ')).toBeNull()
  expect(staffReasonHeader(' Report #12: café ')).toEqual({
    'X-Staff-Reason': 'Report%20%2312%3A%20caf%C3%A9',
  })
  const long = staffReasonHeader('é'.repeat(STAFF_REASON_MAX + 5))
  expect(decodeURIComponent(long!['X-Staff-Reason'])).toBe('é'.repeat(STAFF_REASON_MAX))
})

const here: View = { kind: 'channel', server: 'club', channelId: 7 }
const elsewhere: View = { kind: 'channel', server: 'club', channelId: 3 }
const admin = { ...me('root'), is_site_admin: true }
const base = { me: admin, view: here, staffAsk: null, staffShut: null, staffOpen: [] }

test('a refusal asks once and closes the view only when it shows that channel', () => {
  expect(staffAsked(base, 7)).toEqual({ staffAsk: 7, staffShut: here })
  expect(staffAsked({ ...base, view: elsewhere }, 7)).toEqual({ staffAsk: 7 })
  expect(staffAsked({ ...base, view: null }, 7)).toEqual({ staffAsk: 7 })
  expect(staffAsked({ ...base, staffAsk: 9 }, 7)).toEqual({ staffShut: here })
  expect(staffAsked({ ...base, staffAsk: 9, view: elsewhere }, 7)).toEqual({})
  expect(staffAsked({ ...base, me: me('bob') }, 7)).toEqual({})
  expect(staffAsked({ ...base, me: null }, 7)).toEqual({})
})

test('a confirmation answers its question and opens the channel until it ends', () => {
  const asked = { ...base, staffAsk: 7, staffShut: here }
  expect(staffOpened(asked, 7)).toEqual({ staffAsk: null, staffShut: null, staffOpen: [7] })
  expect(staffOpened({ ...asked, staffAsk: 9, staffOpen: [7] }, 7)).toEqual({
    staffShut: null,
    staffOpen: [7],
  })
  expect(staffOpened({ ...asked, staffShut: elsewhere }, 7)).toEqual({
    staffAsk: null,
    staffOpen: [7],
  })
  const open = { ...base, staffOpen: [3, 7] }
  expect(staffEnded(open, 7)).toEqual({ staffOpen: [3], staffShut: here })
  expect(staffEnded({ ...open, view: elsewhere }, 7)).toEqual({ staffOpen: [3] })
})

test('a channel view reads again only when its confirmation opens it', () => {
  expect(staffChange(false, true)).toBe('read')
  expect(staffChange(true, false)).toBe('close')
  expect(staffChange(false, false)).toBeNull()
  expect(staffChange(true, true)).toBeNull()
})
