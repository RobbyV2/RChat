// Writes assets/p2p_limits.json from the P2P limits registry, for the instance to check
// P2P_LIMITS against. Run with `bun apps/web/scripts/p2p_limits_json.ts` and commit the result.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'
import { registryJson } from '../app/lib/p2p/limits'

const OUT = fileURLToPath(new URL('../../../assets/p2p_limits.json', import.meta.url))

const config = await resolveConfig(OUT)
writeFileSync(OUT, await format(JSON.stringify(registryJson()), { ...config, parser: 'json' }))
