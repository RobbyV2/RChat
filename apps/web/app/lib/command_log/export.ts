import { scrubEntry } from './redact'
import type { LogEntry } from './types'

export const EXPORT_FORMAT = 'rchat-command-log'

export const exportJson = (account: string, entries: LogEntry[], now: number) =>
  JSON.stringify(
    {
      format: EXPORT_FORMAT,
      v: 1,
      account,
      exported_at: now,
      entries: entries.map(e => scrubEntry(e)),
    },
    null,
    2
  )

const COLUMNS = ['at', 'via', 'action', 'title', 'target', 'args', 'outcome', 'text']

// A cell a spreadsheet would read as a formula gets a leading quote.
const cell = (raw: string) => {
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const time = (at: number) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export const exportCsv = (entries: LogEntry[]) =>
  [
    COLUMNS.join(','),
    ...entries
      .map(e => scrubEntry(e))
      .map(e =>
        [
          time(e.at),
          e.via,
          e.action,
          e.title,
          e.target?.label ?? '',
          (e.args ?? []).map(a => `${a.name}=${a.value}`).join('; '),
          e.outcome,
          e.text ?? '',
        ]
          .map(cell)
          .join(',')
      ),
    '',
  ].join('\r\n')
