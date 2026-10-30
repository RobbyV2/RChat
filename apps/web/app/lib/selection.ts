// Message selection: which rows of one scope (`c{channel}`, `t{thread root}`, `d{dm}`) are picked.
// "All" is kept as `{ all: true, except }`, so rows loaded later (scrolling, jumps) are picked
// as soon as they show; unchecking one adds it to `except`. Picking by author works the same way
// for one author at a time (the server deletes "all from this author" as a job, like "all").

import type { Message } from './types'

export interface Selection {
  scope: string
  all: boolean
  ids: ReadonlySet<number>
  authors: ReadonlySet<string>
  except: ReadonlySet<number>
  // The row a Shift+click or the mobile "Select range" helper extends from.
  anchor: number | null
  // Mobile range helper: the next tap ends a range at the anchor.
  ranging: boolean
  // For `all` or an author: how many messages the server counted in the scope.
  estimate: number | null
}

type Row = Pick<Message, 'id' | 'author'>

const NONE: ReadonlySet<never> = new Set()

export const emptySelection = (scope: string, anchor: number | null = null): Selection => ({
  scope,
  all: false,
  ids: NONE,
  authors: NONE,
  except: NONE,
  anchor,
  ranging: false,
  estimate: null,
})

const plus = <T>(set: ReadonlySet<T>, items: Iterable<T>): ReadonlySet<T> => {
  const next = new Set(set)
  for (const item of items) next.add(item)
  return next
}

const minus = <T>(set: ReadonlySet<T>, items: Iterable<T>): ReadonlySet<T> => {
  const next = new Set(set)
  let changed = false
  for (const item of items) changed = next.delete(item) || changed
  return changed ? next : set
}

export const isSelected = (sel: Selection | null, m: Row) => {
  if (!sel || sel.except.has(m.id)) return false
  return sel.all || sel.ids.has(m.id) || sel.authors.has(m.author.username)
}

// Picks every row in `rows` (rows a rule already covers just leave `except`).
const pick = (sel: Selection, rows: Row[]): Selection => {
  const ids = rows.map(r => r.id)
  const except = minus(sel.except, ids)
  const needed = rows.filter(r => !sel.all && !sel.authors.has(r.author.username)).map(r => r.id)
  return { ...sel, except, ids: needed.length ? plus(sel.ids, needed) : sel.ids }
}

const unpick = (sel: Selection, rows: Row[]): Selection => {
  const ruled = rows.filter(r => sel.all || sel.authors.has(r.author.username)).map(r => r.id)
  return {
    ...sel,
    ids: minus(
      sel.ids,
      rows.map(r => r.id)
    ),
    except: ruled.length ? plus(sel.except, ruled) : sel.except,
  }
}

export const toggle = (sel: Selection, m: Row): Selection => {
  const next = isSelected(sel, m) ? unpick(sel, [m]) : pick(sel, [m])
  return { ...next, anchor: m.id, ranging: false }
}

// The rows from `from` to `to` (either order) in `list`, the loaded rows of the scope in order.
export const between = <T extends Row>(list: T[], from: number, to: number): T[] => {
  const a = list.findIndex(m => m.id === from)
  const b = list.findIndex(m => m.id === to)
  if (b === -1) return []
  if (a === -1) return [list[b]]
  return list.slice(Math.min(a, b), Math.max(a, b) + 1)
}

// Shift+click: picks the rows from the anchor to `m`, keeping what was picked before.
export const selectRange = (sel: Selection, list: Row[], m: Row): Selection => {
  if (sel.anchor === null) return toggle(sel, m)
  const next = pick(sel, between(list, sel.anchor, m.id))
  return { ...next, anchor: m.id, ranging: false }
}

export const selectAll = (sel: Selection): Selection => ({
  ...emptySelection(sel.scope, sel.anchor),
  all: true,
})

// Picks every message of `username` in the scope, loaded or not. One author at a time: picking
// another replaces the rule (explicit picks stay).
export const selectAuthor = (sel: Selection, username: string, list: Row[]): Selection => {
  if (sel.all) return { ...sel, except: minus(sel.except, ids(list, username)) }
  if (sel.authors.has(username)) return { ...sel, except: minus(sel.except, ids(list, username)) }
  return {
    ...sel,
    authors: new Set([username]),
    except: NONE,
    estimate: null,
  }
}

// The author rule, if any.
export const ruleAuthor = (sel: Selection): string | null =>
  sel.all ? null : ([...sel.authors][0] ?? null)

const ids = (list: Row[], username: string) =>
  list.filter(m => m.author.username === username).map(m => m.id)

export const clear = (sel: Selection): Selection => emptySelection(sel.scope, sel.anchor)

// What the next tap does with the mobile range helper on.
export const rangeTap = (sel: Selection, list: Row[], m: Row): Selection => {
  if (sel.anchor === null || !list.some(r => r.id === sel.anchor))
    return { ...pick(sel, [m]), anchor: m.id, ranging: true }
  return selectRange(sel, list, m)
}

// The loaded rows that are picked, in list order.
export const selectedIn = <T extends Row>(sel: Selection | null, list: T[]): T[] =>
  sel ? list.filter(m => isSelected(sel, m)) : []

// Explicitly picked ids that are not (or no longer) loaded still count.
export const pickedIds = (sel: Selection, list: Row[]): number[] => {
  const out = new Set(selectedIn(sel, list).map(m => m.id))
  for (const id of sel.ids) if (!sel.except.has(id)) out.add(id)
  return [...out]
}

export const isEmpty = (sel: Selection, list: Row[]) =>
  !sel.all && !sel.authors.size && pickedIds(sel, list).length === 0

const number = (n: number) => n.toLocaleString('en-US')

// The bar's label. Explicit picks count the loaded rows, as delete, copy and export do.
export const selectionLabel = (sel: Selection, list: Row[], me?: string) => {
  const about = (head: string, extra = 0) =>
    sel.estimate === null
      ? head
      : `${head} (about ${number(Math.max(0, sel.estimate - sel.except.size) + extra)})`
  if (sel.all) return about('All messages selected')
  const author = ruleAuthor(sel)
  if (author !== null) {
    const extra = selectedIn(sel, list).filter(m => m.author.username !== author).length
    return about(
      author === me ? 'All your messages selected' : 'All from this person selected',
      extra
    )
  }
  return `${number(selectedIn(sel, list).length)} selected`
}

export interface DeleteCounts {
  // Messages picked, the ones the viewer may delete, and those that need Manage messages.
  total: number
  mine: number
  others: number
}

export const deleteCounts = (picked: Row[], me: string, moderator: boolean): DeleteCounts => {
  const mine = picked.filter(m => moderator || m.author.username === me).length
  return { total: picked.length, mine, others: picked.length - mine }
}

const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`

// The confirm text for deleting picked messages; null when none of them can be deleted.
export const deleteBody = (c: DeleteCounts, dm: boolean) => {
  if (!c.mine) return null
  const head = `Delete ${plural(c.total, 'message', 'messages')}?`
  if (!c.others) return `${head} This cannot be undone.`
  const theirs = dm
    ? `${c.others === 1 ? '1 belongs' : `${number(c.others)} belong`} to the other person.`
    : c.others === 1
      ? '1 belongs to someone else and needs Manage messages.'
      : `${number(c.others)} belong to others and need Manage messages.`
  return `${head} You can delete ${number(c.mine)} of them. ${theirs}`
}

export const deleteAllBody = (deletable: number, where: string) =>
  `Delete all ${plural(deletable, 'message', 'messages')} you can delete ${where}?`

// The confirm text for "all from this author" (no name: streamer mode), plus `extra` other picked
// messages the viewer may delete.
export const deleteAuthorBody = (deletable: number, where: string, mine: boolean, extra = 0) => {
  const head = mine
    ? deletable === 1
      ? `Delete your 1 message ${where}?`
      : `Delete all ${number(deletable)} of your messages ${where}?`
    : `Delete all ${plural(deletable, 'message', 'messages')} from this person you can delete ${where}?`
  return extra
    ? `${head} ${plural(extra, 'other selected message is', 'other selected messages are')} deleted too.`
    : head
}

// Plain text of messages: an author/time line, then the text, a blank line between messages.
export const plainText = (list: Message[], stamp: (ts: number) => string) =>
  list
    .map(m => {
      const head = `${m.author.display_name} (@${m.author.username}) ${stamp(m.created_at)}`
      const body = m.kind === 'poll' && m.poll ? `Poll: ${m.poll.question}` : m.content
      const file = m.media && !m.media.removed ? `\n[${m.media.filename}]` : ''
      return `${head}\n${body}${file}`
    })
    .join('\n\n')

export const EXPORT_VERSION = 1

// One exported message (see the Task 42 report for the schema).
export interface ExportedMessage {
  id: number
  author: { username: string; display_name: string }
  created_at: number
  edited_at: number | null
  kind: Message['kind']
  content: string
  reply_to: number | null
  thread_root_id: number | null
  attachment: { filename: string; kind: string } | null
  poll: { question: string; options: string[] } | null
}

export const exported = (m: Message): ExportedMessage => ({
  id: m.id,
  author: { username: m.author.username, display_name: m.author.display_name },
  created_at: m.created_at,
  edited_at: m.edited_at ?? null,
  kind: m.kind,
  content: m.content,
  reply_to: m.reply_to?.id ?? null,
  thread_root_id: m.thread_root_id,
  attachment:
    m.media && !m.media.removed ? { filename: m.media.filename, kind: m.media.kind } : null,
  poll: m.poll ? { question: m.poll.question, options: m.poll.options.map(o => o.text) } : null,
})

// Rows a checkbox is shown on: user messages and polls, or call and system rows the viewer may
// delete.
export const selectable = (m: Pick<Message, 'kind'>, canDelete: boolean) =>
  m.kind === 'user' || m.kind === 'poll' || canDelete
