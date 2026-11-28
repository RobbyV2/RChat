import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Anchored } from '../../../components/ui'

function Count() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>Pressed {n}</button>
}

function Fixture() {
  const [open, setOpen] = useState(false)
  const [inner, setInner] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(!open)}>
        Open
      </button>
      <p data-outside>Outside</p>
      {open && (
        <Anchored anchor={{ el: anchor }} label="Panel" onClose={() => setOpen(false)}>
          {sheet => (
            <>
              <input aria-label="Text" />
              <Count />
              <output>{sheet ? 'sheet' : 'floating'}</output>
              <button ref={more} onClick={() => setInner(true)}>
                More
              </button>
            </>
          )}
        </Anchored>
      )}
      {inner && (
        <Anchored anchor={{ el: more }} raised label="Inner" onClose={() => setInner(false)}>
          inner
        </Anchored>
      )}
    </>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Fixture />)
