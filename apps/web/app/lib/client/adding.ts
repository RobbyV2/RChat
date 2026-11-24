import { client } from './client'
import { addingAllowed } from '../add_instance'
import { shellInfo } from '../platform'
export function canAddInstance() {
  const own = client.live().find(a => a.conn.isDefault)
  return addingAllowed(
    !!shellInfo(),
    process.env.NEXT_PUBLIC_CLIENT_ONLY === 'true',
    own?.store.getState().settings.client_other_instances !== false
  )
}
