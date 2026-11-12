// Where a component's data comes from: a declared query (params are rule expressions), a record
// id expression (route param, row, args), or a field of the enclosing record.
export type Bind =
  { query: string; params?: Record<string, string> } | { record: string } | { field: string }

export type On =
  | { action: string; args?: Record<string, string> }
  | { op: 'create'; collection: string; values?: Record<string, string> }
  | { op: 'update'; values?: Record<string, string> }
  | { op: 'delete' }
  | { op: 'navigate'; route: string; params?: Record<string, string> }
  | { op: 'open'; dialog: string }
  | { op: 'close' }
  | { op: 'signal'; kind: string; values?: Record<string, string> }
  // The host's own share dialog for the record in scope.
  | { op: 'share' }
  // The member's own private mark on the record in scope (a star, read).
  | { op: 'mark'; kind: string; value?: string }

// `when` is a rule over me, route and record; `menu` holds action names.
type Base = { key?: string; when?: string; menu?: string[] }

export type Node = Base &
  (
    | {
        c: 'stack' | 'row'
        gap?: 0 | 1 | 2 | 3 | 4
        align?: 'start' | 'center' | 'end' | 'stretch'
        wrap?: boolean
        children: Node[]
      }
    | { c: 'section'; title: string; collapsible?: boolean; children: Node[] }
    | { c: 'tabs'; tabs: { label: string; icon?: string; view: Node }[] }
    | { c: 'card'; title?: string; subtitle?: string; on?: On; children: Node[] }
    | { c: 'split'; ratio?: number; min_px?: number; a: Node; b: Node }
    | { c: 'toolbar'; children: Node[] }
    | { c: 'dialog'; name: string; title: string; children: Node[]; sheet_on_phone?: boolean }
    | { c: 'banner'; text: string; tone?: Tone; on?: On; action_label?: string }
    | { c: 'empty'; icon: string; title: string; text?: string; on?: On; action_label?: string }
    | { c: 'scope'; bind: Bind; children: Node[] }
    | {
        c: 'text'
        text: string
        style?: 'body' | 'label' | 'title' | 'caption' | 'code'
        tone?: Tone
      }
    | { c: 'markdown'; bind?: Bind; text?: string }
    | {
        c: 'value'
        bind: Bind
        format?: 'auto' | 'date' | 'time' | 'relative' | 'number' | 'percent' | 'bytes'
      }
    // `src` is a file of the package ("assets/..."), never a URL; `bind` is a file field.
    | { c: 'image'; bind?: Bind; src?: string; alt: string; fit?: 'contain' | 'cover' }
    | { c: 'icon'; name: string; label: string }
    | { c: 'badge'; text: string; tone?: Tone }
    | {
        c: 'stat'
        label: string
        bind: Bind
        agg?: 'count' | 'sum' | 'avg' | 'min' | 'max'
        field?: string
      }
    | { c: 'progress'; bind?: Bind; value?: string; label: string }
    | { c: 'avatars'; bind: Bind; field: string; max?: number }
    | { c: 'member'; bind: Bind }
    | { c: 'code'; bind?: Bind; text?: string; lang?: string }
    | { c: 'diff'; a: Bind; b: Bind }
    | { c: 'media'; bind: Bind; label: string }
    | { c: 'files'; bind: Bind; field: string; upload?: boolean; label: string }
    | { c: 'timer'; until: string; label: string; done_text?: string }
    | { c: 'list'; bind: Bind; item: Node; empty?: Node; virtual?: boolean; label: string }
    | {
        c: 'table'
        bind: Bind
        columns: Column[]
        label: string
        on_row?: On
        inline_edit?: boolean
        group_by?: string
      }
    | { c: 'tree'; bind: Bind; parent: string; item: Node; label: string; drag?: boolean }
    | { c: 'board'; bind: Bind; column_field: string; item: Node; label: string; drag?: boolean }
    | {
        c: 'calendar'
        bind: Bind
        start: string
        end?: string
        title: string
        views?: ('month' | 'week' | 'day' | 'agenda')[]
        label: string
      }
    | { c: 'timeline'; bind: Bind; at: string; item: Node; label: string }
    | { c: 'gallery'; bind: Bind; image: string; title: string; label: string }
    | {
        c: 'chart'
        bind: Bind
        kind: 'line' | 'bar' | 'area' | 'pie' | 'scatter' | 'heatmap'
        x: string
        y: string[]
        label: string
      }
    | { c: 'sheet'; bind: Bind; label: string }
    | {
        c: 'form'
        collection: string
        bind?: Bind
        fields?: string[]
        sections?: FormSection[]
        steps?: FormSection[]
        submit: string
        on_done?: On
      }
    | { c: 'input'; field: string; label?: string; kind?: InputKind; placeholder?: string }
    | {
        c: 'button'
        label: string
        icon?: string
        variant?: 'filled' | 'tonal' | 'text' | 'danger'
        on: On
      }
    | { c: 'search'; target: string; label: string; filters?: string[] }
    | { c: 'pad'; field: string; label: string; mode: 'draw' | 'signature' }
    | { c: 'doc'; bind: Bind; label: string; comments?: boolean; presence?: boolean }
    | { c: 'slides'; bind: Bind; label: string; comments?: boolean; presence?: boolean }
    | { c: 'scene'; bind: Bind; label: string; presence?: boolean }
    | { c: 'thread'; bind: Bind; label: string }
    | { c: 'reactions'; bind: Bind }
    | { c: 'vote'; bind: Bind; collection: string; field: string; mode: 'updown' | 'up' | 'stars' }
    | { c: 'poll'; bind: Bind; label: string }
    | { c: 'presence'; bind?: Bind; label: string }
    | { c: 'call'; bind: Bind; label: string }
    | { c: 'letter'; bind: Bind; label: string }
    // Needs the app_frame capability.
    | { c: 'frame'; label: string; height?: number }
    | { c: 'plugin'; surface: string; label: string }
  )

export type Tone = 'default' | 'muted' | 'primary' | 'error' | 'success'
export type InputKind =
  | 'text'
  | 'multiline'
  | 'markdown'
  | 'rich'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'select'
  | 'radio'
  | 'segmented'
  | 'chips'
  | 'tags'
  | 'toggle'
  | 'slider'
  | 'rating'
  | 'color'
  | 'file'
  | 'member'
  | 'role'
  | 'record'

export interface Column {
  field: string
  label?: string
  width?: number
  pin?: boolean
  sort?: boolean
  filter?: boolean
  format?: 'auto' | 'date' | 'relative' | 'number' | 'bytes'
  // How the column shows when the table becomes cards.
  phone?: 'title' | 'subtitle' | 'meta' | 'hide'
}

export interface FormSection {
  title: string
  fields: string[]
  // A rule over the draft (args) and me.
  when?: string
}

export type Release = 'first' | 'later'

export interface CatalogRow {
  c: Node['c']
  group: 'layout' | 'display' | 'data' | 'input' | 'live' | 'integration'
  release: Release
  binds: 'none' | 'record' | 'query' | 'field' | 'doc'
  phone: string
  a11y: string
}
