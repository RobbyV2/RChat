export type Key = 'new_password' | 'totp' | 'backup_phrase'

export type Requirement = { key: Key; label: string; step: string; ask: string; action: string }

export const REQUIREMENTS: readonly Requirement[] = [
  {
    key: 'new_password',
    label: 'A password of your own',
    step: 'Choose your own password',
    ask: 'Choose your own password',
    action: 'Change',
  },
  {
    key: 'totp',
    label: 'Authenticator codes',
    step: 'Set up an authenticator app',
    ask: 'Set up authenticator codes',
    action: 'Set up',
  },
  {
    key: 'backup_phrase',
    label: 'A saved backup phrase',
    step: 'Save a backup phrase',
    ask: 'Save a backup phrase',
    action: 'Set up',
  },
]

export const WHY = 'This instance requires it.'
export const ADMIN_LINE = 'You can also change this requirement in Site administration.'

export type Unmet = { key: string; deadline?: number | null }
export type MeProtections = { unmet: Unmet[]; restricted: boolean }
export type Mode = 'none' | 'grace' | 'restricted'
export type FormatDate = (unixSecs: number) => string

const known = (unmet: readonly Unmet[]) =>
  REQUIREMENTS.flatMap(r => {
    const hit = unmet.find(u => u.key === r.key)
    return hit ? [{ requirement: r, deadline: hit.deadline ?? null }] : []
  })

export const modeOf = (p: MeProtections | null): Mode =>
  !p || p.unmet.length === 0 ? 'none' : p.restricted ? 'restricted' : 'grace'

export const banner = (p: MeProtections | null, date: FormatDate, hidden = false) => {
  if (hidden || modeOf(p) !== 'grace') return null
  const first = known(p?.unmet ?? [])[0]
  if (!first) return null
  const { requirement, deadline } = first
  return {
    key: requirement.key,
    text: deadline === null ? `${requirement.ask}.` : `${requirement.ask} by ${date(deadline)}.`,
    action: requirement.action,
  }
}

export const guidedSetup = (
  p: MeProtections,
  required: readonly string[],
  date: FormatDate,
  admin: { isSiteAdmin: boolean; noUsableAdmin: boolean } = {
    isSiteAdmin: false,
    noUsableAdmin: false,
  }
) => {
  const unmet = known(p.unmet)
  const current = unmet[0] ?? null
  const steps = REQUIREMENTS.filter(r => required.includes(r.key)).map(r => ({
    key: r.key,
    label: r.label,
    state: !unmet.some(u => u.requirement.key === r.key)
      ? ('Done' as const)
      : r.key === current?.requirement.key
        ? ('Now' as const)
        : ('Next' as const),
  }))
  const deadline = current?.deadline ?? null
  return {
    heading: 'This instance requires a few things before you continue.',
    steps,
    current: current?.requirement.key ?? null,
    later: !p.restricted && deadline !== null ? `You have until ${date(deadline)}` : null,
    adminLine: admin.isSiteAdmin && admin.noUsableAdmin ? ADMIN_LINE : null,
  }
}

export const serverBanner = (server: string) =>
  `${server} needs two-factor for your role. Your moderator tools here are off until you set it up.`
