import type { ServerJoining, SiteSettings } from './types'

type Site = Pick<SiteSettings, 'server_joining'>

// How people get into servers by themselves on this site. An older site lets everyone join.
export const joiningOf = (s: Site): ServerJoining => s.server_joining ?? 'everyone'

// Whether a name alone lets an account join: no password, and the site lets everyone join.
export const joinableByName = (hasPassword: boolean, s: Site) =>
  !hasPassword && joiningOf(s) === 'everyone'

// What new people need to join a server on this site, or nothing when a name is enough.
export const joinNeeds = (hasPassword: boolean, s: Site) => {
  switch (joiningOf(s)) {
    case 'nobody':
      return 'Nobody new can join.'
    case 'invites':
      return 'New people need a password or invite.'
    case 'everyone':
      return hasPassword ? 'New people need a password.' : ''
  }
}

// The Public choice of a server's access settings. `readable`: whether people who aren't
// members can read the server.
export const publicDetail = (s: Site, readable: boolean) =>
  joiningOf(s) === 'everyone'
    ? 'Anyone can join with the server name.'
    : `${readable ? 'Anyone can read it.' : 'Only members can open it.'} ${joinNeeds(false, s)}`

// The Password protected choice of a server's access settings.
export const protectedDetail = (s: Site, readable: boolean) =>
  `${joinNeeds(true, s)}${readable ? '' : ' The server stays hidden.'}`

// What a server becomes when it stops needing a password.
export const goingPublic = (s: Site, readable: boolean) =>
  joiningOf(s) === 'everyone'
    ? 'Anyone will be able to join with the server name.'
    : `${readable ? 'Anyone will be able to read it.' : 'Only members will be able to open it.'} ${joinNeeds(false, s)}`
