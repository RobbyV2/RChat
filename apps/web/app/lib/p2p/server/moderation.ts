import { getEvents } from '../dag'
import { syncedSince as syncedIn, type HeadsReport, type Reached } from '../flows'
import { membershipOf } from '../state'
import type { Link } from '../sync'
import type { ServerCtx } from './context'
import type { Rt } from './rt'

// `run` (a moderation action) is signed only after a member sent us its heads since it was
// asked for and we hold everything they named, or once the user applies it anyway. Null when
// it was cancelled.
export function moderate<T>(
  cx: ServerCtx,
  room: string,
  what: { act: string; who?: string },
  run: () => Promise<T>
): Promise<T | null> {
  const rt = cx.ensureRt(room)
  return new Promise<T | null>((done, fail) => {
    rt.mods.push({
      id: ++cx.modSeq,
      act: what.act,
      who: what.who ?? null,
      at: cx.clock.now(),
      force: false,
      run,
      done: done as (v: unknown) => void,
      fail,
    })
    cx.sync.exchange(room)
    cx.changed(room)
    void cx.runMods(room)
  })
}

export function applyAnyway(cx: ServerCtx, room: string, id: number) {
  const m = cx.rt(room)?.mods.find(x => x.id === id)
  if (!m) return
  m.force = true
  void cx.runMods(room)
}

export function cancelMod(cx: ServerCtx, room: string, id: number) {
  const rt = cx.rt(room)
  const m = rt?.mods.find(x => x.id === id)
  if (!rt || !m) return
  rt.mods = rt.mods.filter(x => x !== m)
  m.done(null)
  cx.changed(room)
}

// A peer's heads: what a waiting moderation action checks.
export function heard(cx: ServerCtx, link: Link) {
  if (!cx.rooms.has(link.room)) return
  const rt = cx.ensureRt(link.room)
  rt.reports.set(link.ik, { at: cx.clock.now(), state: link.peerState })
  if (rt.mods.length) void cx.runMods(link.room)
}

export async function runMods(cx: ServerCtx, room: string) {
  const rt = cx.rt(room)
  if (!rt || rt.modsBusy) return
  rt.modsBusy = true
  try {
    while (rt.mods.length) {
      // One applied anyway goes at once, wherever it waits; the others in order, once synced.
      let i = rt.mods.findIndex(x => x.force)
      if (i < 0) {
        if (!(await cx.syncedSince(room, rt.mods[0].at))) break
        i = 0
      }
      const [m] = rt.mods.splice(i, 1)
      cx.changed(room)
      try {
        m.done(await m.run())
      } catch (e) {
        m.fail(e)
      }
    }
  } finally {
    rt.modsBusy = false
  }
}

export async function syncedSince(cx: ServerCtx, room: string, since: number) {
  const rt = cx.ensureRt(room)
  const s = cx.sumOf(room)
  const reports: HeadsReport[] = []
  for (const [ik, r] of rt.reports) {
    if (r.at < since) continue
    const held = new Set((await getEvents(cx.db, room, r.state)).map(x => x.id))
    let missing = 0
    for (const id of r.state)
      if (!held.has(id) && !rt.rejected.has(id) && !(await cx.db.get('dropped', id))) missing++
    reports.push({ ik, at: r.at, missing })
  }
  return syncedIn(since, reports, ik => ik !== cx.me && membershipOf(s, ik) === 'join')
}

export function noteReached(cx: ServerCtx, rt: Rt, list: Reached[]) {
  for (const r of list) {
    const cur = rt.reached.find(x => x.by === r.by)
    if (cur) cur.lost = [...new Set([...cur.lost, ...r.lost])].sort()
    else rt.reached.push({ by: r.by, lost: [...r.lost] })
  }
}

export function dismissReached(cx: ServerCtx, room: string, by: string) {
  const rt = cx.ensureRt(room)
  rt.reached = rt.reached.filter(x => x.by !== by)
  cx.changed(room)
}

// "Invite them again": an invite for each of them who is still out; contacts hear of it at once.
export async function inviteAgain(cx: ServerCtx, room: string, by: string) {
  const rt = cx.ensureRt(room)
  const r = rt.reached.find(x => x.by === by)
  if (!r) return
  cx.dismissReached(room, by)
  // Each one apart: who couldn't be invited (a limit, say) stays in the note.
  const left: string[] = []
  let why: unknown = null
  for (const ik of r.lost) {
    const m = membershipOf(cx.sumOf(room), ik)
    if (m === 'join' || m === 'ban' || m === 'invite') continue
    try {
      if (cx.deps.node.contact(ik)?.state === 'mutual') await cx.invite(room, ik)
      else await cx.emit(room, 'add', () => ({ to: ik }))
    } catch (e) {
      left.push(ik)
      why ??= e
    }
  }
  if (!left.length) return
  cx.noteReached(rt, [{ by, lost: left }])
  cx.changed(room)
  throw why
}
