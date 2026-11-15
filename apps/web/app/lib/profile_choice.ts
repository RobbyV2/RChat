// Settings > Privacy: who can see an account's profile and find it by name, and which choices
// the site lets an account make.

// The site's own level (`profile_visibility`).
export type ProfileLevel = 'everyone' | 'public_servers' | 'shared'

// What the site lets accounts choose (`profile_choices`).
export type ProfileChoices = 'any' | 'narrower' | 'site'

// An account's own choice; `default` follows the site.
export type ProfileChoice = 'default' | 'friends' | 'shared' | 'everyone'

type Own = Exclude<ProfileChoice, 'default'>

export const PROFILE_CHOICE_LABEL: Record<Own, string> = {
  friends: 'Friends only',
  shared: 'People I share a server with',
  everyone: 'Everyone',
}

const LEVEL_LABEL: Record<ProfileLevel, string> = {
  everyone: 'Everyone',
  public_servers: 'People in public servers',
  shared: 'People I share a server with',
}

// How open each is, least open first.
const RANK: Record<Own | ProfileLevel, number> = {
  friends: 0,
  shared: 1,
  public_servers: 2,
  everyone: 3,
}

const OWN: Own[] = ['friends', 'shared', 'everyone']

interface Site {
  profile_visibility?: ProfileLevel
  profile_choices?: ProfileChoices
}

// The choices the site lets an account make, the site default first. None when the site
// decides, or on an instance without the setting.
export const profileOptions = (s: Site): { value: ProfileChoice; label: string }[] => {
  const level = s.profile_visibility
  if (!level || s.profile_choices === 'site') return []
  const own = OWN.filter(c => s.profile_choices === 'any' || RANK[c] <= RANK[level])
  return [
    { value: 'default', label: `Site default (${LEVEL_LABEL[level]})` },
    ...own.map(value => ({ value, label: PROFILE_CHOICE_LABEL[value] })),
  ]
}

// The choice to show as picked: the saved one while the site allows it, else the default it
// acts as.
export const shownProfileChoice = (saved: ProfileChoice, s: Site): ProfileChoice =>
  profileOptions(s).some(o => o.value === saved) ? saved : 'default'

// The line shown instead of the choices while the site decides.
export const profileChoiceLine = (s: Site): string | null =>
  s.profile_visibility && s.profile_choices === 'site'
    ? `The site sets this: ${LEVEL_LABEL[s.profile_visibility]}.`
    : null

export const parseProfileChoice = (raw: unknown): ProfileChoice =>
  raw === 'friends' || raw === 'shared' || raw === 'everyone' ? raw : 'default'

export const parseProfileLevel = (raw: unknown): ProfileLevel | undefined => {
  if (raw === undefined) return undefined
  return raw === 'everyone' || raw === 'public_servers' ? raw : 'shared'
}

// An instance from before the choices only lets accounts narrow; a value this app does not
// know offers nothing to choose.
export const parseProfileChoices = (raw: unknown): ProfileChoices => {
  if (raw === undefined) return 'narrower'
  return raw === 'any' || raw === 'narrower' ? raw : 'site'
}

// Server settings: "Members can be seen by people outside this server".
export const MEMBERS_VISIBLE_LABEL = 'Members can be seen by people outside this server'

export const membersVisibleLine = (visible: boolean) =>
  visible
    ? 'People who can open this server without joining can see its members and find them by name.'
    : 'Only members see who is here and their profiles. Members who chose Everyone can still be found.'

// The option as the server sent it: null for a server from before it, which has no switch.
export const parseMembersVisible = (raw: unknown): boolean | null =>
  typeof raw === 'boolean' ? raw : null

// Whether the viewer sees a server's member list: members and the site admin always, anyone
// else while the server shows its members to people outside it.
export const seesMembers = (visible: boolean | undefined, member: boolean, siteAdmin: boolean) =>
  member || siteAdmin || visible !== false

export const MEMBERS_HIDDEN_LINE = 'Only members can see who is in this server.'
