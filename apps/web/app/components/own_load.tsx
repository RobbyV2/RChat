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
