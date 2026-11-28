// The report rules shared with the server (`crates/reports`, in the module `perms.ready()`
// loads): the default report forms, the check of a report's answers, the caps on the reports one
// account sends, and the earlier messages a report about a message takes along.

import { decode, type ReportForms, type StoredAnswer } from './api/gen'
import { sharedRules } from './perms'
import { arr, choice, obj, parseJson, str, union, type Schema } from './schema'

export interface GivenAnswer {
  id: string
  value: unknown
}

export interface AnswerRefusal {
  part: 'form' | 'answers'
  msg: string
}

export type Checked = { ok: true; answers: StoredAnswer[] } | { ok: false; refused: AnswerRefusal }

export interface ReportCaps {
  sameTargetSecs: number
  targetsPerDay: number
  perWeek: number
  feedbackPerWeek: number
}

// A report the same sender sent earlier: its target key (null without a target) and when, in
// seconds.
export interface SentReport {
  target: string | null
  at: number
}

const unreadable = () => new Error('The report rules could not be read')

export const defaultForms = (): ReportForms => {
  const read = parseJson(sharedRules().reports_default_forms(), decode.ReportForms)
  if (!read.ok) throw unreadable()
  return read.value
}

const CHECKED: Schema<{ ok: StoredAnswer[] } | { refused: AnswerRefusal }> = union(
  obj({ ok: arr(decode.StoredAnswer) }),
  obj({ refused: obj({ part: choice('form', 'answers'), msg: str() }) })
)

// The answers of a report against the category `form` of `forms`, as the report keeps them. A
// reference answer names someone or somewhere in up to `nameMax` characters.
export const checkAnswers = (
  forms: ReportForms,
  form: string,
  answers: GivenAnswer[],
  nameMax: number
): Checked => {
  const out = sharedRules().reports_validate(
    JSON.stringify(forms),
    form,
    JSON.stringify(answers),
    nameMax
  )
  const read = parseJson(out, CHECKED)
  if (!read.ok) throw unreadable()
  return 'ok' in read.value
    ? { ok: true, answers: read.value.ok }
    : { ok: false, refused: read.value.refused }
}

// Whether one more report about `target` (null for one without a target) may go out at `t`.
export const reportAllowed = (
  sent: SentReport[],
  target: string | null,
  caps: ReportCaps,
  t: number
) =>
  sharedRules().reports_allowed(
    JSON.stringify(sent),
    target ?? undefined,
    caps.sameTargetSecs,
    caps.targetsPerDay,
    caps.perWeek,
    caps.feedbackPerWeek,
    t
  )

// Of the messages held (their order keys, in any order), the ones a report about the message
// with key `reported` takes along: the latest `count` before it, oldest first.
export const contextOf = (held: number[], reported: number, count: number): number[] =>
  Array.from(sharedRules().reports_context(Float64Array.from(held), reported, count))
