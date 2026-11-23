import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InboxPanel } from '../../../components/inbox'
import { AccountProvider } from '../../client/react'
import { client } from '../../client/client'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'

const shown = client.shown()
const owner = new AccountSession(new InstanceConnection(endpointsFrom('https://owner.test', null)))

function Fixture() {
  const [session, setSession] = useState(owner)
  return (
    <AccountProvider session={session}>
      <button onClick={() => setSession(shown)}>Switch account</button>
      <InboxPanel />
    </AccountProvider>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Fixture />)
