import { railBlocks } from './rail_blocks'
import type { SwitcherRow } from './switcher_rows'

// Mirror rail order, excluding guests and sessions that have not been admitted to this device.
export function dmBlocks<T>(
  groups: Parameters<typeof railBlocks>[0],
  onlyOrigin: string | undefined,
  resolve: (row: SwitcherRow) => T | undefined
) {
  return railBlocks(groups, onlyOrigin)
    .blocks.map(g => ({
      ...g,
      owners: g.accounts.flatMap(row => {
        if (row.username === null) return []
        const owner = resolve(row)
        return owner ? [{ row, owner }] : []
      }),
    }))
    .filter(g => g.owners.length > 0)
}
