// The command log: what this account ran on this device, and the replies only it saw.

export type LogVia = 'palette' | 'menu' | 'key' | 'bar' | 'button' | 'server' | 'notice' | 'api'

export type LogOutcome = 'ok' | 'error' | 'cancelled' | 'info'

export type LogUndo = 'available' | 'used' | 'expired'

// Ids only, for "Open".
export interface LogRef {
  server?: string
  channel?: number
  message?: number
  dm?: number
  p2p?: string
}

export interface LogActor {
  account: string
  identity?: string
}

export interface LogTarget {
  kind: string
  label: string
  ref?: LogRef
}

export interface LogArg {
  name: string
  value: string
}

export interface LogEntry {
  v: 1
  id: string
  at: number
  actor: LogActor
  via: LogVia
  action: string
  title: string
  target?: LogTarget
  args?: LogArg[]
  outcome: LogOutcome
  text?: string
  ms?: number
  undo?: LogUndo
}

// What a run answers, as far as the log reads it.
export interface LogResult {
  kind: 'ok' | 'info' | 'error'
  text: string
  name?: string
  detail?: string
  undo?: unknown
  onlyYou?: boolean
}

// A place in a reply where the server put an argument's value, in UTF-16 code units.
export interface LogSpan {
  start: number
  end: number
  arg: string
}

export interface LogPrefs {
  v: 1
  on: boolean
  days: number
  max: number
  keep_after_sign_out: boolean
}
