import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ShareTarget } from '../../../components/share_target'

let finish: ((value: unknown) => void) | undefined
let takes = 0
Object.assign(window, {
  __RCHAT_DESKTOP__: { os: 'ios', version: 'test' },
  __TAURI_INTERNALS__: {
    invoke(command: string) {
      if (command !== 'take_incoming_share') throw new Error(command)
      document.body.dataset.takes = String(++takes)
      return new Promise(resolve => {
        finish = resolve
      })
    },
  },
})

function Fixture() {
  const [path, setPath] = useState('/login/')
  const [mounted, setMounted] = useState(true)
  return (
    <PathnameContext.Provider value={path}>
      {mounted && <ShareTarget />}
      <button onClick={() => setPath('/conversation/')}>Change route</button>
      <button onClick={() => finish?.({ text: 'Native fixture', files: [] })}>Finish take</button>
      <button onClick={() => setMounted(false)}>Unmount host</button>
    </PathnameContext.Provider>
  )
}
createRoot(document.body).render(<Fixture />)
