import { describe, expect, test } from 'bun:test'
import {
  goingPublic,
  joinNeeds,
  joinableByName,
  joiningOf,
  protectedDetail,
  publicDetail,
} from '../joining'
import type { ServerJoining } from '../types'

const site = (server_joining?: ServerJoining) => ({ server_joining })

const JOINING: ServerJoining[] = ['everyone', 'invites', 'nobody']

const plain = (line: string) => !/[–—]|RChat/.test(line) && line.length < 90

describe('joiningOf', () => {
  test('an older site lets everyone join', () => {
    expect(joiningOf(site())).toBe('everyone')
    for (const joining of JOINING) expect(joiningOf(site(joining))).toBe(joining)
  })

  test('a name alone joins only a server without a password while everyone may join', () => {
    expect(joinableByName(false, site('everyone'))).toBe(true)
    expect(joinableByName(true, site('everyone'))).toBe(false)
    for (const joining of ['invites', 'nobody'] as const) {
      expect(joinableByName(false, site(joining))).toBe(false)
      expect(joinableByName(true, site(joining))).toBe(false)
    }
  })
})

describe('publicDetail', () => {
  test('says anyone can join only while the site lets everyone join', () => {
    expect(publicDetail(site('everyone'), true)).toBe('Anyone can join with the server name.')
    expect(publicDetail(site(), true)).toBe('Anyone can join with the server name.')
    expect(publicDetail(site('invites'), false)).toBe(
      'Only members can open it. New people need a password or invite.'
    )
    expect(publicDetail(site('nobody'), false)).toBe(
      'Only members can open it. Nobody new can join.'
    )
  })

  test('says who reads it when people who are not members can', () => {
    expect(publicDetail(site('invites'), true)).toBe(
      'Anyone can read it. New people need a password or invite.'
    )
    expect(publicDetail(site('nobody'), true)).toBe('Anyone can read it. Nobody new can join.')
  })

  test('never promises joining by name while the site restricts joining', () => {
    for (const joining of ['invites', 'nobody'] as const)
      for (const readable of [true, false])
        expect(publicDetail(site(joining), readable)).not.toContain('join with the server name')
  })
})

describe('protectedDetail', () => {
  test('says what a password does and whether the server stays hidden', () => {
    expect(protectedDetail(site('everyone'), false)).toBe(
      'New people need a password. The server stays hidden.'
    )
    expect(protectedDetail(site('invites'), false)).toBe(
      'New people need a password or invite. The server stays hidden.'
    )
    expect(protectedDetail(site('nobody'), false)).toBe(
      'Nobody new can join. The server stays hidden.'
    )
    expect(protectedDetail(site('everyone'), true)).toBe('New people need a password.')
    expect(protectedDetail(site('nobody'), true)).toBe('Nobody new can join.')
  })
})

describe('goingPublic', () => {
  test('says what a server without a password is on this site', () => {
    expect(goingPublic(site('everyone'), true)).toBe(
      'Anyone will be able to join with the server name.'
    )
    expect(goingPublic(site('invites'), false)).toBe(
      'Only members will be able to open it. New people need a password or invite.'
    )
    expect(goingPublic(site('nobody'), false)).toBe(
      'Only members will be able to open it. Nobody new can join.'
    )
    expect(goingPublic(site('invites'), true)).toBe(
      'Anyone will be able to read it. New people need a password or invite.'
    )
  })
})

describe('joinNeeds', () => {
  test('says what joining needs on this site', () => {
    expect(joinNeeds(false, site('everyone'))).toBe('')
    expect(joinNeeds(true, site('everyone'))).toBe('New people need a password.')
    for (const hasPassword of [false, true]) {
      expect(joinNeeds(hasPassword, site('invites'))).toBe('New people need a password or invite.')
      expect(joinNeeds(hasPassword, site('nobody'))).toBe('Nobody new can join.')
    }
  })
})

test('every line is short, plain copy', () => {
  for (const joining of [...JOINING, undefined])
    for (const readable of [true, false])
      for (const hasPassword of [true, false])
        for (const line of [
          publicDetail(site(joining), readable),
          protectedDetail(site(joining), readable),
          goingPublic(site(joining), readable),
          joinNeeds(hasPassword, site(joining)),
        ])
          expect([line, plain(line)]).toEqual([line, true])
})
