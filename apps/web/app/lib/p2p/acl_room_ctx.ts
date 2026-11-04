import type { AclRoom } from './acl_room'

// What the room's storage policy and flows modules read and call of the room: the AclRoom itself,
// seen through the members they use (private ones too).
export interface RoomCtx {
  bodiless: AclRoom['bodiless']
  contents: AclRoom['contents']
  counted: AclRoom['counted']
  cv: AclRoom['cv']
  dirty: AclRoom['dirty']
  evals: AclRoom['evals']
  evict: AclRoom['evict']
  evicted: AclRoom['evicted']
  evictedEdits: AclRoom['evictedEdits']
  gone: AclRoom['gone']
  heads: AclRoom['heads']
  inviteOf: AclRoom['inviteOf']
  maxContent: AclRoom['maxContent']
  plan: AclRoom['plan']
  r: AclRoom['r']
  shows: AclRoom['shows']
  stab: AclRoom['stab']
  stabAt: AclRoom['stabAt']
  view: AclRoom['view']
}
