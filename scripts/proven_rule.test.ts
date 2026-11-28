import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

const found = async (file: string, code: string) => {
  const [result] = await new ESLint({ cwd: root }).lintText(code, {
    filePath: join(root, file),
  })
  return result.messages.filter(m => m.ruleId === 'no-restricted-syntax').length
}

test('only a check gives a value its proven type', async () => {
  const forms = [
    "import type { CheckedWire2, WireV2 } from './event_v2'\nexport const x = (w: WireV2) => w as CheckedWire2\n",
    "import type { CheckedWire2 } from './event_v2'\nexport const x = (w: unknown) => w as unknown as CheckedWire2\n",
    "import type { CheckedWire, Wire } from './event_v1'\nexport const x = (w: Wire) => w as CheckedWire\n",
    "import type { Admitted, Received } from './acl_room'\nexport const x = (r: Received) => r as Admitted\n",
    "import type { Judged, Received } from './acl_room'\nexport const x = (r: Received) => r as Judged\n",
    "import type { Proven } from './proven'\nexport const x = (r: string) => r as Proven<string, 'checked'>\n",
  ]
  for (const code of forms) {
    expect([code, await found('apps/web/app/lib/p2p/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/p2p/dag.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/p2p/server/emit.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/lib/slices/x.ts', code)]).toEqual([code, 1])
    expect([code, await found('apps/web/app/components/x.tsx', code)]).toEqual([code, 1])
  }
  for (const prover of ['event_v1.ts', 'event_v2.ts', 'acl_room.ts', 'server/receive.ts'])
    expect([prover, await found(`apps/web/app/lib/p2p/${prover}`, forms[0])]).toEqual([prover, 0])
  const plain =
    "import type { Wire } from './event_v1'\nexport const x = (w: unknown) => w as unknown as Wire\n"
  expect(await found('apps/web/app/lib/p2p/x.ts', plain)).toBe(0)
}, 180_000)
