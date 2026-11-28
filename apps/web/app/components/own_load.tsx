'use client'

import { useStore } from '../lib/client/react'
import type { OwnLoad } from '../lib/own_loads'
import { ErrorNotice } from './notices'

// The refusal of a load the store made on its own, where the person looks for what it loads.
// `lead` says what did not load; `retry` asks again.
export function OwnLoadNotice({
  what,
  lead,
  retry,
}: {
  what: OwnLoad
  lead: string
  retry: () => void
}) {
  const refusal = useStore(s => s.refusedLoads[what])
  return refusal ? <ErrorNotice refusal={refusal} lead={lead} retry={retry} /> : null
}

// What the open chat could not do on its own account after trying again quietly: save what was
// read, and load the rows of the people it names.
export function ChatWorkNotices({ server }: { server: string | null }) {
  const resend = useStore(s => s.resendReadMarks)
  const retryRows = useStore(s => s.retryMemberRows)
  return (
    <>
      <OwnLoadNotice
        what="read_marks"
        lead="Could not save what you have read. Unread marks may come back."
        retry={resend}
      />
      {server !== null && (
        <OwnLoadNotice
          what={`members:${server}`}
          lead="Could not load some names and role colors in this server."
          retry={() => retryRows(server)}
        />
      )}
    </>
  )
}
