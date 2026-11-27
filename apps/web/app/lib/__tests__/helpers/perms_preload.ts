import { pathToFileURL } from 'node:url'
import { setRulesBase } from '../../perms_load'
import { WASM, loadPerms } from './perms'

// The P2P rules decide through the shared permission rules, so every test file starts with
// them loaded, and workers started by a test load the same build.
setRulesBase(pathToFileURL(WASM).href)
await loadPerms()
