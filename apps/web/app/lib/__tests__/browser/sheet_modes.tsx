import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sheet } from '../../../components/ui'

function Count() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>Pressed {n}</button>
}

function Fixture() {
  const [sheet, setSheet] = useState(true)
  return (
    <>
      <button data-turn onClick={() => setSheet(!sheet)}>
        Turn
      </button>
      <Sheet
        sheet={sheet}
        float={{ at: 'top-2 right-3 w-[26rem]', backdrop: 'none' }}
        aria-label="Panel"
        onClose={() => {}}
      >
        <input aria-label="Text" />
        <Count />
      </Sheet>
    </>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Fixture />)
