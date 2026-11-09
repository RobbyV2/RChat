import type { InstanceAuditEntry } from './types'

export interface AuditPart {
  text: string
  // A username: blurred in streamer mode.
  name?: boolean
}

// Known actions read as a sentence; `target` says they act on an account.
const ACTIONS: Record<string, { verb: string; target: boolean }> = {
  'user.remove_phrase': { verb: 'removed the backup phrase of', target: true },
}

// One line of the instance audit log: who did what to whom. Unknown actions show their code.
export const instanceAuditLine = (e: InstanceAuditEntry): AuditPart[] => {
  const known = Object.hasOwn(ACTIONS, e.action) ? ACTIONS[e.action] : undefined
  const actor: AuditPart =
    e.actor === null ? { text: 'Deleted user' } : { text: e.actor, name: true }
  const target: AuditPart[] =
    e.target !== null
      ? [{ text: ' ' }, { text: e.target, name: true }]
      : known?.target
        ? [{ text: ' a deleted user' }]
        : []
  return [actor, { text: ` ${known?.verb ?? e.action}` }, ...target]
}
