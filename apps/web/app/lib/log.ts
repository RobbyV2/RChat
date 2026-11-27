import { Secret } from './secret'

const made: unique symbol = Symbol('log field')

// A value that may appear in a log line. Only `label` and `cause` make one.
export class LogField {
  readonly shown: unknown

  constructor(key: typeof made, shown: unknown) {
    if (key !== made) throw new TypeError('log fields come from label and cause')
    this.shown = shown
  }
}

const LABEL_MAX = 64

// A short identifier from the code (an action id, a message type): never free text.
export const label = (name: unknown): LogField =>
  new LogField(
    made,
    typeof name === 'string' ? name.replace(/[^\w.:/-]/g, '_').slice(0, LABEL_MAX) : typeof name
  )

const CAUSE_MAX = 200

// What was thrown. An error keeps its stack; any other object is named by its type only, so a
// value that holds personal data or a secret is never printed.
export const cause = (thrown: unknown): LogField => {
  if (thrown instanceof Secret) return new LogField(made, String(thrown))
  if (thrown instanceof Error) return new LogField(made, thrown)
  if (typeof thrown === 'string') return new LogField(made, thrown.slice(0, CAUSE_MAX))
  if (typeof thrown === 'number' || typeof thrown === 'boolean' || thrown == null)
    return new LogField(made, thrown)
  return new LogField(made, Object.prototype.toString.call(thrown))
}

type Literal<W extends string> = string extends W ? never : W
type Field = number | boolean | LogField

const shown = (field: Field) => (field instanceof LogField ? field.shown : field)

// `what` is a text written in the code. Everything else is a number, a flag or a `LogField`.
export const logError = <const W extends string>(what: Literal<W>, ...fields: Field[]) =>
  console.error(what, ...fields.map(shown))

export const logWarn = <const W extends string>(what: Literal<W>, ...fields: Field[]) =>
  console.warn(what, ...fields.map(shown))
