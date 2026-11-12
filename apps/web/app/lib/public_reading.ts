import { joinNeeds, joinableByName } from './joining'
import type { SiteSettings } from './types'

// A server's "Anyone can read this server" option: on, off, or null to follow the site.
export type PublicRead = boolean | null

type Site = Pick<SiteSettings, 'server_joining' | 'public_reading' | 'guests_enabled'>

// Whether the site lets server owners make servers publicly readable.
export const publicReadingAllowed = (s: Site) => s.public_reading !== false

// What the option is while it follows the site: readable like the servers anyone can join.
export const siteDefault = (hasPassword: boolean, s: Site) => joinableByName(hasPassword, s)

// Whether people who aren't members can read the server right now.
export const readableNow = (option: PublicRead, hasPassword: boolean, s: Site) =>
  publicReadingAllowed(s) && (option ?? siteDefault(hasPassword, s))

// The line under the option: what it means right now.
export const readingLine = (option: PublicRead, hasPassword: boolean, s: Site) => {
  if (!publicReadingAllowed(s)) return 'Public reading is turned off on this site.'
  if (!readableNow(option, hasPassword, s)) return 'Only members can read this server.'
  const who = s.guests_enabled
    ? "People who aren't members"
    : "People with an account who aren't members"
  const needs = joinNeeds(hasPassword, s)
  return `${who} can read it and talk in voice.${needs ? ` ${needs}` : ''}`
}

export type ReadingChoice = 'default' | 'on' | 'off'

export const choiceOf = (option: PublicRead): ReadingChoice =>
  option === null ? 'default' : option ? 'on' : 'off'

export const optionOf = (choice: ReadingChoice): PublicRead =>
  choice === 'default' ? null : choice === 'on'

// The three states, with what the site default is right now.
export const readingChoices = (
  hasPassword: boolean,
  s: Site
): { value: ReadingChoice; label: string }[] => [
  { value: 'default', label: `Site default (${siteDefault(hasPassword, s) ? 'on' : 'off'})` },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

// What the control shows: the stored choice, or off while the site turned public reading off.
export const shownChoice = (option: PublicRead, s: Site): ReadingChoice =>
  publicReadingAllowed(s) ? choiceOf(option) : 'off'
