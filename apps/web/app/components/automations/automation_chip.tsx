// Always shown next to an automation's name, whatever name it posted with. `by`: on a P2P
// server, whose device ran it or who saved it.
export function AutomationChip({ by }: { by?: { how: 'run' | 'saved'; name: string } }) {
  return (
    <>
      <span
        title="Posted by an automation, not by a member"
        className="shrink-0 self-center rounded-md bg-tertiary-container px-1 py-px text-[10px] leading-4 font-semibold tracking-wide text-on-tertiary-container"
      >
        AUTOMATION
      </span>
      {by && (
        <span className="min-w-0 truncate text-xs text-on-surface-variant">
          {by.how === 'run' ? 'run by ' : 'saved by '}
          <span className="streamer">{by.name}</span>
        </span>
      )}
    </>
  )
}
