import { HIDDEN } from './redact'
import type { LogArg } from './types'

export type LogPolicy = 'keep' | 'hide' | 'omit'
export type StepKind = 'choice' | 'text' | 'confirm' | 'user' | 'duration' | 'date'

export const ECHO_MIN = 4

// What a step logs when it declares nothing: text is hidden, a confirm is left out, the rest
// keep their label.
export const stepPolicy = (kind: StepKind, declared?: LogPolicy): LogPolicy =>
  declared ?? (kind === 'text' ? 'hide' : kind === 'confirm' ? 'omit' : 'keep')

export interface LogStep {
  name: string
  kind: StepKind
  log?: LogPolicy
  // What the user picked, as shown.
  label?: string
}

const has = (args: Record<string, string>, name: string) => Object.hasOwn(args, name)

// A server command's text arguments are always hidden: this device decides, never the server.
const policyOf = (s: LogStep, serverCommand: boolean) =>
  serverCommand && s.kind === 'text' ? 'hide' : stepPolicy(s.kind, s.log)

// The arguments an entry keeps, in step order. A secret action keeps none.
export const loggedArgs = (
  steps: LogStep[],
  args: Record<string, string>,
  secret: boolean,
  serverCommand = false
): LogArg[] =>
  secret
    ? []
    : steps
        .filter(s => has(args, s.name))
        .map(s => ({ s, p: policyOf(s, serverCommand) }))
        .filter(({ p }) => p !== 'omit')
        .map(({ s, p }) => ({
          name: s.name,
          value: p === 'keep' ? (s.label ?? args[s.name]) : HIDDEN,
        }))

const kept = (s: LogStep, secret: boolean, serverCommand: boolean) =>
  !secret && policyOf(s, serverCommand) === 'keep'

// The names of the arguments a reply must not echo.
export const hiddenNames = (
  steps: LogStep[],
  args: Record<string, string>,
  secret: boolean,
  serverCommand = false
) => steps.filter(s => has(args, s.name) && !kept(s, secret, serverCommand)).map(s => s.name)

// Their values, of 4 or more characters.
export const hiddenValues = (
  steps: LogStep[],
  args: Record<string, string>,
  secret: boolean,
  serverCommand = false
) =>
  hiddenNames(steps, args, secret, serverCommand)
    .map(name => args[name])
    .filter(v => Array.from(v).length >= ECHO_MIN)
