import type { ReactNode } from 'react'
import { Inset } from '../layout'
// Always shown next to an automation's name, whatever name it posted with. `by`: on a P2P
// server, whose device ran it or who saved it, with the name as the name component draws it.
export function AutomationChip({ by }: { by?: { how: 'run' | 'saved'; name: ReactNode } }) {
  return (
    <>
      <Inset
        title="Posted by an automation, not by a member"
        as="span"
        pad="2xs"
        inset="bar"
        look="rounded-md bg-tertiary-container text-3xs leading-4 font-semibold tracking-wide text-on-tertiary-container"
        place="shrink-0 self-center"
      >
        AUTOMATION
      </Inset>
      {by && (
        <span className="min-w-0 truncate text-xs text-on-surface-variant">
          {by.how === 'run' ? 'run by ' : 'saved by '}
          {by.name}
        </span>
      )}
    </>
  )
}
