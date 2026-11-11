export type FedService = 'letters' | 'invites' | 'profiles' | 'reports' | 'directory'

export type HostStatus = {
  host: string
  name: string | null
  reachable: boolean | null
  services: Partial<Record<FedService, boolean>>
}

export type GateWhy =
  | 'blocked'
  | 'identity'
  | 'unsupported'
  | 'hello'
  | 'version'
  | 'halted'
  | 'paused'
  | 'refused_by_them'
  | 'paused_by_them'
  | 'identity_by_them'
  | 'held'
  | 'waiting'

export type ChipContext = 'chip' | 'letters' | 'invite'
export type Chip = { dot: boolean; title: string | null; line: string | null }

export const STATUS_TTL = 60_000
export const STATUS_MAX = 200

export const closedForUsers = (why: GateWhy | null) =>
  why !== null && why !== 'held' && why !== 'hello'

export const serviceWorks = (status: HostStatus | null, service: FedService) =>
  status?.reachable === true && status.services[service] === true

export const chipFor = (status: HostStatus | null, context: ChipContext): Chip => {
  if (status?.reachable === false)
    return {
      dot: true,
      title: `${status.host} can't be reached from here right now.`,
      line:
        context === 'letters'
          ? 'Letters wait up to 7 days.'
          : context === 'invite'
            ? 'Preview not available from here.'
            : null,
    }
  return { dot: false, title: null, line: null }
}

export type OutboxEvent = { host: string; reachable?: boolean }

export const statusCache = () => {
  const rows = new Map<string, { at: number; status: HostStatus }>()
  return {
    get(host: string, now = Date.now()) {
      const hit = rows.get(host)
      return hit && now - hit.at < STATUS_TTL ? hit.status : undefined
    },
    put(status: HostStatus, now = Date.now()) {
      rows.delete(status.host)
      rows.set(status.host, { at: now, status })
      const oldest = rows.keys().next().value
      if (rows.size > STATUS_MAX && oldest !== undefined) rows.delete(oldest)
    },
    outbox({ host, reachable }: OutboxEvent, now = Date.now()) {
      const hit = rows.get(host)
      if (!hit) return
      if (reachable === undefined) rows.delete(host)
      else rows.set(host, { at: now, status: { ...hit.status, reachable } })
    },
    clear() {
      rows.clear()
    },
  }
}

export type StatusCache = ReturnType<typeof statusCache>
