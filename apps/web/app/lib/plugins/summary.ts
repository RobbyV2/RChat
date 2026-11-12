import { FULL, PERMS, egress, netHost, reads, risk } from './perm_text'

export interface Summary {
  full: boolean
  // Permissions that let it see data.
  reads: string[]
  // Permissions that let it pass data on.
  egress: string[]
  // Some read meets some way out.
  passesOn: boolean
}

// What a set of permissions adds up to, at install, on update and on a runtime request. A
// plugin's own permissions and those of what it depends on are summarized as one list.
export const summary = (perms: readonly string[]): Summary => {
  const full = perms.includes(FULL)
  const r = perms.filter(reads)
  const e = perms.filter(egress)
  return { full, reads: r, egress: e, passesOn: full || (r.length > 0 && e.length > 0) }
}

const ORDER = ['C', 'H', 'M', 'L']
const byRisk = (perms: readonly string[]) =>
  [...perms].sort((a, b) => ORDER.indexOf(`${risk(a)}`) - ORDER.indexOf(`${risk(b)}`))

// An item with a list of its own inside is set apart, so the two lists don't run together.
const simple = (text: string) => !/,| and |;/.test(text)
const list = (given: readonly string[]) => {
  const items = [...new Set(given)]
  const last = items[items.length - 1]
  if (items.length < 2) return items.join('')
  if (items.every(simple)) return `${items.slice(0, -1).join(', ')} and ${last}`
  if (items.length === 2) return `${items[0]}, as well as ${last}`
  return `${items.slice(0, -1).join('; ')}; and ${last}`
}

// The hosts of the net permissions, or "any website" when one of them is the wildcard.
const sites = (perms: readonly string[]) => {
  const hosts = perms.map(netHost).filter((h): h is string => h !== null)
  return hosts.includes('*') ? ['any website'] : hosts
}

// The dialog's top line. With a read and a way out: "Can read X and pass it on to Y". With
// reads only: "Can read X". With neither: what it can do. Null for Full access, whose own
// dialog replaces the list, and when the catalog knows none of the names.
export const summaryLine = (perms: readonly string[]): string | null => {
  const s = summary(perms)
  if (s.full) return null
  const hosts = sites(perms)
  if (s.reads.length === 0) {
    const does = byRisk(perms).flatMap(p =>
      netHost(p) !== null ? [`exchange data with ${list(hosts)}`] : (PERMS[p]?.can ?? [])
    )
    return does.length ? `Can ${list(does)}` : null
  }
  const sorted = byRisk(s.reads)
  const whats = [...new Set(sorted.map(p => PERMS[p].what ?? ''))]
  const read = `Can read ${list(whats)}`
  if (!s.passesOn) return read
  const tos = [...hosts, ...s.egress.flatMap(p => (netHost(p) === null ? (PERMS[p].to ?? []) : []))]
  const one = whats.length === 1 && !sorted.some(p => PERMS[p].what === whats[0] && PERMS[p].many)
  return `${read}${simple(list(whats)) ? '' : ','} and pass ${one ? 'it' : 'them'} on to ${list(tos)}`
}
