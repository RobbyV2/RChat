// Runs the rig against an instance. Usage:
//   bun scripts/identity/rp/main.ts --issuer http://127.0.0.1:3910 --client-id <id> [--client-secret <secret>] [--port 3912] [--scope "profile servers"]
import { parseArgs } from 'node:util'
import { startRig } from './server'

const { values } = parseArgs({
  options: {
    issuer: { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
    port: { type: 'string', default: '3912' },
    scope: { type: 'string', default: 'profile' },
  },
})

const issuer = values.issuer
const clientId = values['client-id']
const port = Number(values.port)
if (!issuer || !clientId || !Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(
    'usage: bun scripts/identity/rp/main.ts --issuer <url> --client-id <id> [--client-secret <secret>] [--port 3912] [--scope "profile servers"]'
  )
  process.exit(2)
}

const rig = startRig({
  issuer: issuer.replace(/\/+$/, ''),
  clientId,
  clientSecret: values['client-secret'],
  port,
  scopes: (values.scope ?? 'profile').split(/[ ,]+/).filter(Boolean),
})
console.log(
  `relying party on ${rig.url} (redirect ${rig.url}/cb, back-channel ${rig.url}/backchannel)`
)
