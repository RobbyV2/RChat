import { describe, expect, test } from 'bun:test'
import { shownUser } from '../people'
import type { MemberLook, UserRef } from '../types'

const alice: UserRef = {
  username: 'alice',
  display_name: 'Alice',
  avatar_kind: 'identicon',
  avatar_color: '#112233',
  avatar_image: null,
}

describe('a person as a place shows them', () => {
  test('the same account and look give the same person', () => {
    const look: MemberLook = {
      name: 'Al',
      avatar_kind: null,
      avatar_color: null,
      avatar_image: null,
    }
    const first = shownUser(alice, look)
    expect(first.display_name).toBe('Al')
    expect(first.avatar_color).toBe('#112233')
    expect(shownUser(alice, look)).toBe(first)
    expect(shownUser(alice, null)).toBe(shownUser(alice, undefined))
    expect(shownUser(alice, null)).not.toBe(first)
  })

  test('another look, or the account changed, gives another person', () => {
    const look: MemberLook = {
      name: 'Al',
      avatar_kind: null,
      avatar_color: null,
      avatar_image: null,
    }
    const first = shownUser(alice, look)
    expect(shownUser(alice, { ...look })).not.toBe(first)
    expect(shownUser(alice, { ...look })).toEqual(first)
    const renamed = { ...alice, display_name: 'Alicia' }
    expect(shownUser(renamed, look)).not.toBe(first)
    expect(shownUser(renamed, { ...look, name: null }).display_name).toBe('Alicia')
  })
})
