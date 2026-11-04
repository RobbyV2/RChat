'use client'

import { textBtn } from '../ui'
import { useReveal } from './reveal'

// The words in order. In streamer mode they stay covered until Show, and again each time streamer
// mode is turned on.
export function PhraseWords({ words }: { words: string[] }) {
  const reveal = useReveal()
  if (reveal.hidden)
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-outline-variant p-4 text-center text-sm text-on-surface-variant">
        Hidden in streamer mode
        <button type="button" onClick={reveal.show} className={textBtn}>
          Show
        </button>
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      <ol aria-label="Backup phrase" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {words.map((w, i) => (
          <li
            key={i}
            className="rounded-xl bg-surface-container-high px-3 py-2 font-mono text-sm text-on-surface tabular-nums"
          >
            {`${i + 1}. ${w}`}
          </li>
        ))}
      </ol>
      {reveal.streamer && (
        <button type="button" onClick={reveal.hide} className={`${textBtn} self-start`}>
          Hide
        </button>
      )}
    </div>
  )
}
