import { describe, expect, test } from 'bun:test'
import { insertBlock } from './mobile'

const manifest = `<manifest>
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="RChat">
    </application>
</manifest>`

describe('mobile project patches', () => {
  test('a block goes before the tag, indented like it', () => {
    const out = insertBlock(manifest, 'permissions', '<application', ['<uses-permission a="b" />'])
    expect(out.split('\n').slice(1, 5)).toEqual([
      '    <uses-permission android:name="android.permission.INTERNET" />',
      '    <!-- rchat: permissions -->',
      '    <uses-permission a="b" />',
      '    <!-- rchat: permissions -->',
    ])
  })

  test('closing tags get the block one level deeper', () => {
    const style = '<resources>\n    <style name="T">\n    </style>\n</resources>'
    const out = insertBlock(style, 'splash', '</style>', ['<item name="x">y</item>'])
    expect(out).toContain('\n        <item name="x">y</item>\n')
  })

  test('running twice replaces the block', () => {
    const once = insertBlock(manifest, 'permissions', '<application', ['<a />'])
    const twice = insertBlock(once, 'permissions', '<application', ['<b />'])
    expect(twice).not.toContain('<a />')
    expect(twice.match(/rchat: permissions/g)?.length).toBe(2)
  })

  test('a missing anchor is an error', () => {
    expect(() => insertBlock(manifest, 'x', '<nothing', [])).toThrow()
  })
})
