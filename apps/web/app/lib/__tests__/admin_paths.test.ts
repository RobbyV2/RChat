import { expect, test } from 'bun:test'
import { ADMIN_SECTIONS, adminPath, parsePath, type AdminTarget } from '../view'

const at = (section: AdminTarget['section'], item: string | null = null): AdminTarget => ({
  kind: 'admin',
  section,
  item,
})

test('the admin root and every section round-trip', () => {
  expect(adminPath(null)).toBe('/admin/')
  expect(parsePath('/admin/')).toEqual(at(null))
  expect(parsePath('/admin')).toEqual(at(null))
  for (const section of ADMIN_SECTIONS) {
    expect(adminPath(section)).toBe(`/admin/${section}/`)
    expect(parsePath(adminPath(section))).toEqual(at(section))
    expect(parsePath(`/admin/${section}`)).toEqual(at(section))
  }
})

test('accounts and servers have pages of their own', () => {
  for (const section of ['users', 'servers'] as const)
    for (const item of ['dana', 'my server', 'a/b?c#d', 'café']) {
      const path = adminPath(section, item)
      expect(path.startsWith(`/admin/${section}/`)).toBe(true)
      expect(path.endsWith('/')).toBe(true)
      expect(parsePath(path)).toEqual(at(section, item))
    }
  expect(adminPath('users', 'a b')).toBe('/admin/users/a%20b/')
})

test('other admin paths are unknown paths', () => {
  expect(parsePath('/admin/nowhere/')).toBeNull()
  expect(parsePath('/admin/features/extra/')).toBeNull()
  expect(parsePath('/admin/users/a/b/')).toBeNull()
  expect(parsePath('/admin/users/%E0%A4%A/')).toBeNull()
  expect(parsePath('/administrator/')).toBeNull()
  expect(parsePath('/s/admin/')).toEqual({ kind: 'server', server: 'admin' })
})

test('an item of a section without item pages is that section', () => {
  expect(adminPath('features', 'x')).toBe('/admin/features/')
})
