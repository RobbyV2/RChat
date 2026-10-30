// The store's message selection actions, bulk delete jobs and their events, kept apart from
// store.ts. The rules of what is picked live in `selection.ts`.

import type { BulkDeleteReq } from './api'
import { ApiError } from './api'
import { api } from './instances'
import { canForward } from './forward'
import { messageLinkUrl } from './message_links'
import { canPin, isPinned } from './pins'
import { sharing } from './platform'
import { messageServer, myPerms } from './selectors'
import {
  EXPORT_VERSION,
  clear,
  deleteAllBody,
  deleteAuthorBody,
  deleteBody,
  deleteCounts,
  emptySelection,
  exported,
  isSelected,
  plainText,
  rangeTap,
  ruleAuthor,
  selectAll,
  selectAuthor,
  selectRange,
  selectedIn,
  toggle,
  type Selection,
} from './selection'
import type { RChatState } from './store_types'
import { Perm, hasPerm, type BulkJob, type Message, type WsEvent } from './types'

type SetState = (partial: Partial<RChatState> | ((s: RChatState) => Partial<RChatState>)) => void

export interface SelectionDeps {
  set: SetState
  get: () => RChatState
  toast: (text: string, name?: string) => void
  fail: (e: unknown) => void
  // Drops deleted messages from every list, as `messages_deleted` does.
  dropDeleted: (ids: number[], threadRootId: number | null, server: string | null) => void
}

// Pins and unpins at most this many messages at once.
export const PIN_MAX = 25
export const IDS_MAX = 200
export const EXCEPT_MAX = 1000
// Messages fetched per page when exporting everything.
export const EXPORT_PAGE = 100
// Exports stop after this many messages.
export const EXPORT_MAX = 100_000

export const selectionInitial = () => ({
  selection: null as Selection | null,
  selectAnchor: null as { scope: string; id: number } | null,
  bulkJobs: {} as Record<string, BulkJob>,
  selectionBusy: null as string | null,
})

// Where a scope is: its server (channels and threads), whether it is a DM, and how the confirm
// text names it.
export interface ScopePlace {
  server: string | null
  dm: boolean
  where: string
  root: Message | null
}

export const scopePlace = (s: RChatState, scope: string): ScopePlace => {
  const id = Number(scope.slice(1))
  if (scope.startsWith('d')) return { server: null, dm: true, where: 'in this DM', root: null }
  if (scope.startsWith('t')) {
    const root =
      s.panel?.kind === 'thread' && s.panel.root.id === id
        ? s.panel.root
        : (Object.values(s.messages)
            .flat()
            .find(m => m.id === id) ?? null)
    return {
      server: root ? messageServer(s, root) : null,
      dm: false,
      where: 'in this thread',
      root,
    }
  }
  for (const [server, detail] of Object.entries(s.servers)) {
    const channel = detail.channels.find(c => c.id === id)
    if (channel) return { server, dm: false, where: `in #${channel.name}`, root: null }
  }
  return { server: null, dm: false, where: 'here', root: null }
}

// Whether the viewer may delete other people's messages in `scope`.
export const moderates = (s: RChatState, scope: string) => {
  const { server, dm } = scopePlace(s, scope)
  return !dm && server !== null && hasPerm(myPerms(s, server), Perm.DeleteMessages)
}

export const canDeleteIn = (s: RChatState, scope: string, m: Message) =>
  s.me !== null && !s.guest && (m.author.username === s.me.username || moderates(s, scope))

export const canPinIn = (s: RChatState, scope: string) => {
  if (!s.me || s.guest || scope.startsWith('t')) return false
  const { server, dm } = scopePlace(s, scope)
  if (dm) return true
  return (
    server !== null &&
    s.me.servers.some(x => x.name === server) &&
    hasPerm(myPerms(s, server), Perm.DeleteMessages)
  )
}

export const scopeList = (s: RChatState, scope: string): Message[] => s.messages[scope] ?? []

// The loaded rows picked in the current selection, in list order.
export const pickedMessages = (s: RChatState): Message[] =>
  s.selection ? selectedIn(s.selection, scopeList(s, s.selection.scope)) : []

const stamp = (ts: number) => new Date(ts * 1000).toLocaleString()

const day = () => new Date().toISOString().slice(0, 10)

const fileName = (scope: string, ext: string) => `messages-${scope}-${day()}.${ext}`

const fetchPage = (scope: string, after: number) => {
  const id = Number(scope.slice(1))
  const page = { after, limit: EXPORT_PAGE }
  if (scope.startsWith('c')) return api.channelMessages(id, page)
  if (scope.startsWith('t')) return api.threadMessages(id, page)
  return api.dmMessages(id, page)
}

// Waits before trying a page again after a 429.
export const exportBackoff = { ms: 1000 }

// One export page, tried again (up to 5 times, waiting longer each time) when rate limited.
const fetchAfter = async (scope: string, after: number) => {
  for (let tries = 0; ; tries++) {
    try {
      return await fetchPage(scope, after)
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || tries >= 5) throw e
      await new Promise(r => setTimeout(r, exportBackoff.ms * 2 ** tries))
    }
  }
}

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

export const selectionSlice = (d: SelectionDeps) => {
  const { set, get } = d

  const update = (scope: string, fn: (sel: Selection) => Selection) =>
    set(s => {
      const base =
        s.selection?.scope === scope
          ? s.selection
          : emptySelection(scope, s.selectAnchor?.scope === scope ? s.selectAnchor.id : null)
      return { selection: fn(base) }
    })

  // The server's count for "all", or for all of `author`'s messages.
  const estimate = (scope: string, author: string | null = null) => {
    const req: BulkDeleteReq = { scope, all: true, dry_run: true }
    if (author !== null) req.author = author
    api.bulkDelete(req).then(
      r =>
        set(s => {
          const sel = s.selection
          const same =
            sel?.scope === scope && (author === null ? sel.all : ruleAuthor(sel) === author)
          return same && sel ? { selection: { ...sel, estimate: r.total } } : {}
        }),
      () => {}
    )
  }

  const noteJob = (job: BulkJob) => {
    const before = get().bulkJobs[job.scope]
    set(s => ({ bulkJobs: { ...s.bulkJobs, [job.scope]: job } }))
    if (job.status === 'running' || before?.status !== 'running' || before.id !== job.id) return
    if (job.status === 'done') d.toast(`Deleted ${plural(job.deleted, 'message')}`)
    else if (job.status === 'cancelled')
      d.toast(`Stopped after deleting ${plural(job.deleted, 'message')}`)
    else get().setError(job.error ?? 'Deleting stopped because of an error')
  }

  const deletePicked = async (scope: string, ids: number[], threadRootId: number | null) => {
    let deleted = 0
    for (const part of chunks(ids, IDS_MAX)) {
      const r = await api.bulkDelete({ scope, ids: part })
      d.dropDeleted(r.ids, threadRootId, scopePlace(get(), scope).server)
      deleted += r.deleted
    }
    return deleted
  }

  // Starts the job for what the dry run counted: nothing newer than `upto`.
  const startAll = async (sel: Selection, upto: number | null | undefined, author?: string) => {
    const req: BulkDeleteReq = { scope: sel.scope, all: true, except: [...sel.except] }
    if (upto !== null && upto !== undefined) req.before = upto + 1
    if (author !== undefined) req.author = author
    const r = await api.bulkDelete(req)
    if (r.job) noteJob(r.job)
  }

  const exportAll = async (sel: Selection, format: 'text' | 'json') => {
    const parts: BlobPart[] = []
    let after = 0
    let count = 0
    let first = true
    if (format === 'json')
      parts.push(
        `{"version":${EXPORT_VERSION},"scope":${JSON.stringify(sel.scope)},"exported_at":${Math.floor(Date.now() / 1000)},"messages":[`
      )
    for (;;) {
      const page = await fetchAfter(sel.scope, after)
      const kept = page.filter(m => isSelected(sel, m))
      if (kept.length) {
        const text =
          format === 'json'
            ? kept.map(m => JSON.stringify(exported(m))).join(',')
            : plainText(kept, stamp)
        parts.push(new Blob([`${first ? '' : format === 'json' ? ',' : '\n\n'}${text}`]))
        first = false
        count += kept.length
        set({ selectionBusy: `Exporting ${count.toLocaleString('en-US')} messages` })
      }
      if (page.length < EXPORT_PAGE || count >= EXPORT_MAX) break
      after = Math.max(...page.map(m => m.id))
    }
    if (format === 'json') parts.push(']}')
    return { blob: new Blob(parts, { type: mime(format) }), count }
  }

  const mime = (format: 'text' | 'json') =>
    format === 'json' ? 'application/json' : 'text/plain;charset=utf-8'

  const busy = async (label: string, fn: () => Promise<void>) => {
    if (get().selectionBusy) return
    set({ selectionBusy: label })
    try {
      await fn()
    } catch (e) {
      d.fail(e)
    } finally {
      set({ selectionBusy: null })
    }
  }

  const actions = {
    startSelection: (scope: string, m?: Message) => {
      update(scope, sel => (m ? toggle(sel, m) : sel))
    },
    exitSelection: () => set({ selection: null }),
    setSelectAnchor: (scope: string, id: number) => set({ selectAnchor: { scope, id } }),
    toggleSelect: (scope: string, m: Message) => update(scope, sel => toggle(sel, m)),
    selectRangeTo: (scope: string, m: Message) =>
      update(scope, sel => selectRange(sel, scopeList(get(), scope), m)),
    tapSelect: (scope: string, m: Message) =>
      update(scope, sel =>
        sel.ranging ? rangeTap(sel, scopeList(get(), scope), m) : toggle(sel, m)
      ),
    toggleSelectRange: () =>
      set(s =>
        s.selection
          ? { selection: { ...s.selection, ranging: !s.selection.ranging, anchor: null } }
          : {}
      ),
    selectAllMessages: () => {
      const sel = get().selection
      if (!sel) return
      set({ selection: selectAll(sel) })
      estimate(sel.scope)
    },
    selectAuthorMessages: (username: string) => {
      const sel = get().selection
      if (!sel) return
      const next = selectAuthor(sel, username, scopeList(get(), sel.scope))
      set({ selection: next })
      if (!next.all && next.estimate === null) estimate(sel.scope, username)
    },
    clearSelection: () => set(s => (s.selection ? { selection: clear(s.selection) } : {})),

    askDeleteSelection: () => {
      const s = get()
      const sel = s.selection
      if (!sel || !s.me) return
      const place = scopePlace(s, sel.scope)
      const threadRootId = sel.scope.startsWith('t') ? Number(sel.scope.slice(1)) : null
      if (sel.all) {
        if (sel.except.size > EXCEPT_MAX) {
          s.setError('Uncheck at most 1,000 messages when everything is selected')
          return
        }
        void busy('Counting messages', async () => {
          const r = await api.bulkDelete({
            scope: sel.scope,
            all: true,
            except: [...sel.except],
            dry_run: true,
          })
          if (!r.deletable) {
            get().setError('There are no messages here you can delete')
            return
          }
          get().askConfirm({
            title: 'Delete Messages',
            body: deleteAllBody(r.deletable, place.where),
            confirm: 'Delete',
            action: () =>
              void busy('Deleting messages', async () => {
                await startAll(sel, r.upto)
                get().exitSelection()
              }),
          })
        })
        return
      }
      const picked = selectedIn(sel, scopeList(s, sel.scope))
      const mod = moderates(s, sel.scope)
      const author = ruleAuthor(sel)
      if (author !== null) {
        if (sel.except.size > EXCEPT_MAX) {
          s.setError('Uncheck at most 1,000 messages when everything is selected')
          return
        }
        const me = s.me.username
        const extra = picked
          .filter(m => m.author.username !== author)
          .filter(m => mod || m.author.username === me)
          .map(m => m.id)
        void busy('Counting messages', async () => {
          const r = await api.bulkDelete({
            scope: sel.scope,
            all: true,
            author,
            except: [...sel.except],
            dry_run: true,
          })
          if (!r.deletable && !extra.length) {
            get().setError('There are no messages here you can delete')
            return
          }
          get().askConfirm({
            title: 'Delete Messages',
            body: deleteAuthorBody(r.deletable, place.where, author === me, extra.length),
            confirm: 'Delete',
            action: () =>
              void busy('Deleting messages', async () => {
                const n = extra.length ? await deletePicked(sel.scope, extra, threadRootId) : 0
                if (r.deletable) await startAll(sel, r.upto, author)
                else d.toast(`Deleted ${plural(n, 'message')}`)
                get().exitSelection()
              }),
          })
        })
        return
      }
      const counts = deleteCounts(picked, s.me.username, mod)
      const body = deleteBody(counts, place.dm)
      if (!body) {
        s.setError(
          place.dm
            ? 'You can only delete your own messages here'
            : 'Deleting these messages needs Manage messages'
        )
        return
      }
      const ids = picked.filter(m => mod || m.author.username === s.me?.username).map(m => m.id)
      s.askConfirm({
        title: 'Delete Messages',
        body,
        confirm: 'Delete',
        action: () =>
          void busy('Deleting messages', async () => {
            const n = await deletePicked(sel.scope, ids, threadRootId)
            get().exitSelection()
            d.toast(`Deleted ${plural(n, 'message')}`)
          }),
      })
    },

    pinSelection: (pin: boolean) =>
      busy(pin ? 'Pinning' : 'Unpinning', async () => {
        const s = get()
        const picked = pickedMessages(s).filter(canPin)
        if (!s.selection || picked.length > PIN_MAX || !canPinIn(s, s.selection.scope)) return
        for (const m of picked) {
          if (pin && !isPinned(m)) await get().pinMessage(m.id)
          if (!pin && isPinned(m)) await get().unpinMessage(m.id)
        }
      }),

    copySelectionText: () => {
      const picked = pickedMessages(get())
      if (!picked.length) return
      void sharing()
        .copyText(plainText(picked, stamp))
        .then(ok => (ok ? d.toast(`Copied ${plural(picked.length, 'message')}`) : undefined))
    },

    copySelectionLinks: () => {
      const s = get()
      const links = pickedMessages(s)
        .map(m => messageLinkUrl(m, messageServer(s, m)))
        .filter((l): l is string => !!l)
      if (!links.length) return
      void sharing()
        .copyText(links.join('\n'))
        .then(ok => (ok ? d.toast(`Copied ${plural(links.length, 'link')}`) : undefined))
    },

    forwardSelection: () => {
      const picked = pickedMessages(get())
      if (picked.length === 1 && canForward(picked[0])) get().copyForward(picked[0])
    },

    exportSelection: (format: 'text' | 'json') =>
      busy('Exporting', async () => {
        const sel = get().selection
        if (!sel) return
        const ext = format === 'json' ? 'json' : 'txt'
        if (sel.all || sel.authors.size) {
          const { blob, count } = await exportAll(sel, format)
          sharing().saveBlob(fileName(sel.scope, ext), blob)
          d.toast(`Exported ${plural(count, 'message')}`)
          return
        }
        const picked = pickedMessages(get())
        const text =
          format === 'json'
            ? JSON.stringify({
                version: EXPORT_VERSION,
                scope: sel.scope,
                exported_at: Math.floor(Date.now() / 1000),
                messages: picked.map(exported),
              })
            : plainText(picked, stamp)
        sharing().saveFile(fileName(sel.scope, ext), text, mime(format))
        d.toast(`Exported ${plural(picked.length, 'message')}`)
      }),

    cancelBulkJob: async (scope: string) => {
      const job = get().bulkJobs[scope]
      if (!job || job.status !== 'running') return
      try {
        noteJob(await api.cancelBulkJob(job.id))
      } catch (e) {
        d.fail(e)
      }
    },
  }

  const loadJobs = async () => {
    try {
      const jobs = await api.bulkJobs()
      const running = jobs.filter(j => j.status === 'running')
      set({ bulkJobs: Object.fromEntries(running.map(j => [j.scope, j])) })
    } catch {
      // A failed load leaves the jobs as they were; the next resync tries again.
    }
  }

  const onEvent = (ev: WsEvent): boolean => {
    if (ev.type !== 'bulk_delete_progress') return false
    if (ev.username === get().me?.username) noteJob(ev.job)
    return true
  }

  return { actions, onEvent, loadJobs }
}
