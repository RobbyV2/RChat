import type { createAccountPart } from './account'
import type { createAttachmentsPart } from './attachments'
import type { createBadgePart } from './badge'
import type { createCallsPart } from './calls'
import type { createDmsPart } from './dms'
import type { createInboxPart } from './inbox'
import type { createMovePart } from './move'
import type { createRailPart } from './rail'
import type { createScheduledPart } from './scheduled'
import type { createServersPart } from './servers'
import type { createStorePart } from './store'
import type { createViewingPart } from './viewing'

export type { IdentityScope } from '../identity_scope'
export interface P2pParts {
  store: ReturnType<typeof createStorePart>
  account: ReturnType<typeof createAccountPart>
  attachments: ReturnType<typeof createAttachmentsPart>
  badge: ReturnType<typeof createBadgePart>
  calls: ReturnType<typeof createCallsPart>
  dms: ReturnType<typeof createDmsPart>
  inbox: ReturnType<typeof createInboxPart>
  move: ReturnType<typeof createMovePart>
  rail: ReturnType<typeof createRailPart>
  scheduled: ReturnType<typeof createScheduledPart>
  servers: ReturnType<typeof createServersPart>
  viewing: ReturnType<typeof createViewingPart>
}
