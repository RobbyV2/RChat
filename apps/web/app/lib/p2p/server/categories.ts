import { fromWire, outranks, widened } from '../../perms'
import { EVERYONE, rulesOf, tiered } from '../acl/rules'
import { CATEGORIES_MAX, type OverSum, type Summary } from '../acl/summary'
import { AGREED } from '../limits'
import { clip } from '../rate'
import { channelOf, rankOf, roleRank } from '../state'
import type { ServerCtx } from './context'
import { addChannel, setOverwrite } from './emit'
import { ServerError, newShortId } from './types'

// Categories of a room (`category`, one register per id) and the category of each channel
// (`chcat`, one per channel). Every write starts from the current content, so fields of newer
// versions stay.

const NO_CATEGORY = 'Unknown category'
const RANKED_TEXT = "You can't copy the rules of a role or member ranked above you."
const FULL_TEXT = 'A channel synced with this category has no room for another rule.'

// Whether `me` may write an overwrite for `subj` (ranked above its subject; owners always): a
// role that is gone or a member who left can always be cleared.
const mayWrite = (s: Summary, me: string, subj: string) => {
  if (s.owners.includes(me)) return true
  const mine = tiered(rankOf(s, me))
  if (subj === `r:${EVERYONE}`) return outranks(mine, tiered(roleRank(s, EVERYONE)))
  if (subj.startsWith('r:'))
    return !s.roles[subj.slice(2)] || outranks(mine, tiered(roleRank(s, subj.slice(2))))
  const ik = subj.slice(2)
  return s.members[ik]?.m !== 'join' || outranks(mine, tiered(rankOf(s, ik)))
}

const categoryOf = (cx: ServerCtx, room: string, id: string) => {
  const c = cx.sumOf(room).categories?.[id]
  if (!c) throw new ServerError(NO_CATEGORY)
  return c
}

export async function createCategory(cx: ServerCtx, room: string, name: string) {
  const live = Object.values(cx.sumOf(room).categories ?? {})
  if (live.length >= CATEGORIES_MAX)
    throw new ServerError(`A server can have at most ${CATEGORIES_MAX} categories.`)
  const pos = Math.max(-1, ...live.map(c => c.pos)) + 1
  const id = newShortId()
  return cx
    .emit(room, 'category', () => ({
      id,
      name: clip(name.trim(), cx.local.server.nameMax),
      pos,
    }))
    .then(() => id)
}

export interface CategoryPatch {
  name?: string
  pos?: number
}

export async function editCategory(cx: ServerCtx, room: string, id: string, patch: CategoryPatch) {
  const c = categoryOf(cx, room, id)
  const name = patch.name === undefined ? c.name : clip(patch.name.trim(), cx.local.server.nameMax)
  return cx.emit(room, 'category', () => ({ ...c.extra, id, name, pos: patch.pos ?? c.pos }))
}

// Its channels show without a category afterwards.
export async function deleteCategory(cx: ServerCtx, room: string, id: string) {
  const c = categoryOf(cx, room, id)
  return cx.emit(room, 'category', () => ({
    ...c.extra,
    id,
    name: c.name,
    pos: c.pos,
    gone: true,
  }))
}

// Puts a channel in a category (null: none). A move never changes permissions: the channel stops
// copying a category's overwrites.
export async function placeChannel(cx: ServerCtx, room: string, ch: string, cat: string | null) {
  if (!channelOf(cx.sumOf(room), ch)) throw new ServerError('Unknown channel')
  if (cat !== null) categoryOf(cx, room, cat)
  const cur = cx.sumOf(room).chcats?.[ch]
  return cx.emit(room, 'chcat', () => ({ ...cur?.extra, ch, cat, sync: false }))
}

const sameOver = (a: OverSum | undefined, b: OverSum | undefined) =>
  (a?.allow ?? 0) === (b?.allow ?? 0) && (a?.deny ?? 0) === (b?.deny ?? 0)

// The channels that copy category `cat`'s overwrites.
const copiesOf = (cx: ServerCtx, room: string, cat: string) =>
  Object.entries(cx.sumOf(room).chcats ?? {})
    .filter(([ch, c]) => c.cat === cat && c.sync && channelOf(cx.sumOf(room), ch))
    .map(([ch]) => ch)

// A category's overwrite for `subj` (allow and deny 0 clear it), then the same overwrite in every
// channel that copies the category.
export async function setCategoryOverwrite(
  cx: ServerCtx,
  room: string,
  cat: string,
  subj: string,
  o: OverSum,
  reason?: string
) {
  categoryOf(cx, room, cat)
  const adds = o.allow !== 0 || o.deny !== 0
  for (const ch of copiesOf(cx, room, cat)) {
    const ov = cx.sumOf(room).overwrites?.[ch] ?? {}
    if (adds && !ov[subj] && Object.keys(ov).length >= AGREED.overwrites)
      throw new ServerError(FULL_TEXT)
  }
  await setOverwrite(cx, room, cat, subj, o.allow, o.deny, reason)
  for (const ch of copiesOf(cx, room, cat))
    if (!sameOver(cx.sumOf(room).overwrites?.[ch]?.[subj], o))
      await setOverwrite(cx, room, ch, subj, o.allow, o.deny)
}

// A channel's own overwrite; a channel that copied its category's stops copying them.
export async function setChannelOverwrite(
  cx: ServerCtx,
  room: string,
  ch: string,
  subj: string,
  o: OverSum,
  reason?: string
) {
  await setOverwrite(cx, room, ch, subj, o.allow, o.deny, reason)
  const cur = cx.sumOf(room).chcats?.[ch]
  if (cur?.sync)
    await cx.emit(room, 'chcat', () => ({ ...cur.extra, ch, cat: cur.cat, sync: false }))
}

// The channel's overwrites become its category's, and it copies them from then on.
export async function syncChannel(cx: ServerCtx, room: string, ch: string) {
  const cur = cx.sumOf(room).chcats?.[ch]
  const cat = cur?.cat
  if (!cat || !cx.sumOf(room).categories?.[cat])
    throw new ServerError('This channel is not in a category')
  const now = () => cx.sumOf(room).overwrites ?? {}
  const subjects = new Set([...Object.keys(now()[ch] ?? {}), ...Object.keys(now()[cat] ?? {})])
  for (const subj of subjects)
    if (!sameOver(now()[ch]?.[subj], now()[cat]?.[subj]) && !mayWrite(cx.sumOf(room), cx.me, subj))
      throw new ServerError(RANKED_TEXT)
  for (const subj of subjects) {
    const want = now()[cat]?.[subj]
    if (!sameOver(now()[ch]?.[subj], want))
      await setOverwrite(cx, room, ch, subj, want?.allow ?? 0, want?.deny ?? 0)
  }
  await cx.emit(room, 'chcat', () => ({ ...cur?.extra, ch, cat, sync: true }))
}

// A new channel in category `cat`: unless private, it copies the category's overwrites.
export async function addChannelIn(
  cx: ServerCtx,
  room: string,
  name: string,
  cat: string,
  opts: { restrictView?: boolean; kind?: 'text' | 'voice' } = {}
) {
  categoryOf(cx, room, cat)
  const sync = !opts.restrictView
  if (sync)
    for (const subj of Object.keys(cx.sumOf(room).overwrites?.[cat] ?? {}))
      if (!mayWrite(cx.sumOf(room), cx.me, subj)) throw new ServerError(RANKED_TEXT)
  const ch = await addChannel(cx, room, name, opts)
  if (sync)
    for (const [subj, o] of Object.entries(cx.sumOf(room).overwrites?.[cat] ?? {}))
      await setOverwrite(cx, room, ch, subj, o.allow, o.deny)
  await cx.emit(room, 'chcat', () => ({ ch, cat, sync }))
  return ch
}

// Who syncing channel `ch` with its category lets see or send there who could not before
// (`r:everyone`, `r:<role>`, `u:<member>`), through the shared rules.
export function syncWidens(cx: ServerCtx, room: string, ch: string): string[] {
  const s = cx.sumOf(room)
  const cat = s.chcats?.[ch]?.cat
  const c = channelOf(s, ch)
  if (!cat || !c) return []
  const rules = rulesOf(s.rules)
  const rows = (o: Record<string, OverSum> | undefined) =>
    Object.entries(o ?? {}).map(([subject, { allow, deny }]) => ({
      subject,
      allow: fromWire(allow, rules),
      deny: fromWire(deny, rules),
      merge: false,
    }))
  const roleBits = Object.fromEntries(
    Object.entries(s.roles).map(([id, r]) => [`r:${id}`, fromWire(r.bits, rules)])
  )
  const members = [
    ...Object.keys(s.overwrites?.[ch] ?? {}),
    ...Object.keys(s.overwrites?.[cat] ?? {}),
  ]
    .filter(subj => subj.startsWith('u:'))
    .map(subj => [subj, (s.members[subj.slice(2)]?.roles ?? []).map(R => `r:${R}`)])
  return widened(
    rows(s.overwrites?.[ch]),
    rows(s.overwrites?.[cat]),
    { subject: `r:${EVERYONE}`, bits: fromWire(s.everyone, rules) },
    roleBits,
    Object.fromEntries(members),
    { restrictView: !!c.restrict_view, restrictSend: !!c.restrict_send, voice: c.kind === 'voice' },
    rules
  )
}
