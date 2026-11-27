import { BookOpen } from 'lucide-react'
import { useAccount } from '../lib/client/react'
import { docsFor } from '../lib/docs_link'
import { docsViewer } from '../lib/platform'
import { useStore } from '../lib/store'
import { Button } from './controls'
import { LabelText, useInstanceLabel } from './instance_badge'

// Settings > About and help: opens the docs, or says why they are off.
export function DocsEntry() {
  const acct = useAccount()
  const settings = useStore(s => s.settings)
  const { label } = useInstanceLabel()
  const place = docsFor(acct.conn, settings, label)
  if (place.kind === 'off') return <LabelText text={place.reason} name={label} />
  return (
    <>
      <p>Using the app, running an instance, the API and the P2P protocol.</p>
      <Button
        variant="filled"
        size="md"
        icon={BookOpen}
        place="self-start"
        onClick={() => void docsViewer().open(place.url)}
      >
        Open docs
      </Button>
    </>
  )
}
