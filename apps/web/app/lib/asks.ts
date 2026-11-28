import type { AccountSession } from './client/session'
import type { Page } from './load'
import type { AuditEntry, MemberHit } from './types'

// The requests screens make of the account's instance, named by what they ask for. A screen
// hands one to a load (components/loaded.tsx) or sends it; which endpoint answers it is said
// only here and in the store.
export type Api = AccountSession['api']

// One page of a server's audit log, filtered by `query`.
export const auditPage =
  (server: string, query: Record<string, string>) =>
  (api: Api, cursor: string | null): Promise<Page<AuditEntry>> =>
    api.listAudit(server, cursor, query)

// One page of a server's members that match `query`. `found` hears each page as it arrives.
export const memberSearchPage =
  (server: string, query: string, found: (members: MemberHit[]) => void) =>
  (api: Api, cursor: string | null, signal: AbortSignal): Promise<Page<MemberHit>> =>
    api.searchMembers(server, query, cursor, signal).then(page => {
      found(page.items)
      return page
    })
