import { describe, expect, test } from 'bun:test'
import {
  PROFILE_CHOICE_LABEL,
  parseProfileChoice,
  profileChoiceLine,
  profileOptions,
  shownProfileChoice,
  type ProfileChoice,
  type ProfileChoices,
  type ProfileLevel,
} from '../profile_choice'

const LEVELS: ProfileLevel[] = ['everyone', 'public_servers', 'shared']
const CONTROLS: ProfileChoices[] = ['any', 'narrower', 'site']
const CHOICES: ProfileChoice[] = ['default', 'friends', 'shared', 'everyone']

const site = (profile_visibility?: ProfileLevel, profile_choices?: ProfileChoices) => ({
  profile_visibility,
  profile_choices,
})

const values = (s: ReturnType<typeof site>) => profileOptions(s).map(o => o.value)

describe('profileOptions', () => {
  test('any: the site default and all three choices, at every site level', () => {
    for (const level of LEVELS) {
      expect(values(site(level, 'any'))).toEqual(['default', 'friends', 'shared', 'everyone'])
    }
  })

  test('narrower: only choices that are not wider than the site', () => {
    expect(values(site('everyone', 'narrower'))).toEqual([
      'default',
      'friends',
      'shared',
      'everyone',
    ])
    expect(values(site('public_servers', 'narrower'))).toEqual(['default', 'friends', 'shared'])
    expect(values(site('shared', 'narrower'))).toEqual(['default', 'friends', 'shared'])
  })

  test('site: nothing to choose', () => {
    for (const level of LEVELS) expect(values(site(level, 'site'))).toEqual([])
  })

  test('an instance without the setting offers no row', () => {
    for (const control of CONTROLS) expect(values(site(undefined, control))).toEqual([])
  })

  test('the default names the site level', () => {
    expect(profileOptions(site('shared', 'any'))[0].label).toBe(
      'Site default (People I share a server with)'
    )
    expect(profileOptions(site('public_servers', 'any'))[0].label).toBe(
      'Site default (People in public servers)'
    )
    expect(profileOptions(site('everyone', 'narrower'))[0].label).toBe('Site default (Everyone)')
  })

  test('the choice labels', () => {
    expect(PROFILE_CHOICE_LABEL).toEqual({
      friends: 'Friends only',
      shared: 'People I share a server with',
      everyone: 'Everyone',
    })
  })
})

describe('shownProfileChoice', () => {
  test('a saved choice the site allows is shown, any other as the default', () => {
    for (const level of LEVELS) {
      for (const control of CONTROLS) {
        const allowed = values(site(level, control))
        for (const choice of CHOICES) {
          const shown = shownProfileChoice(choice, site(level, control))
          expect(shown).toBe(allowed.includes(choice) ? choice : 'default')
        }
      }
    }
  })

  test('a saved Everyone reads as the default where only narrowing is allowed', () => {
    expect(shownProfileChoice('everyone', site('shared', 'narrower'))).toBe('default')
    expect(shownProfileChoice('everyone', site('shared', 'any'))).toBe('everyone')
  })
})

describe('profileChoiceLine', () => {
  test('one plain line when the site decides', () => {
    expect(profileChoiceLine(site('shared', 'site'))).toBe(
      'The site sets this: People I share a server with.'
    )
    expect(profileChoiceLine(site('everyone', 'site'))).toBe('The site sets this: Everyone.')
    expect(profileChoiceLine(site('public_servers', 'site'))).toBe(
      'The site sets this: People in public servers.'
    )
  })

  test('no line while the account chooses', () => {
    for (const level of LEVELS) {
      expect(profileChoiceLine(site(level, 'any'))).toBeNull()
      expect(profileChoiceLine(site(level, 'narrower'))).toBeNull()
    }
  })
})

describe('parseProfileChoice', () => {
  test('known choices pass, anything else is the default', () => {
    for (const choice of CHOICES) expect(parseProfileChoice(choice)).toBe(choice)
    for (const odd of [undefined, null, 'public', 'Friends', 3]) {
      expect(parseProfileChoice(odd)).toBe('default')
    }
  })
})
