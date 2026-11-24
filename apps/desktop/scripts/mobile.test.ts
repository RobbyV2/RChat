import { describe, expect, test } from 'bun:test'
import { iosShareProject } from './ios_share'
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

test('iOS share target embeds once, preserves host entitlements and provisions both containers', () => {
  const spec = JSON.stringify({
    targets: {
      RChat_iOS: {
        type: 'application',
        platform: 'iOS',
        dependencies: [{ sdk: 'UIKit.framework' }],
        entitlements: { path: 'RChat.entitlements' },
        info: {
          path: 'RChat/Info.plist',
          properties: { CFBundleVersion: '12', CFBundleShortVersionString: '1.2.0' },
        },
      },
    },
    settingGroups: { app: { base: {} } },
  })
  const first = iosShareProject(spec, () => ({
    'com.apple.developer.associated-domains': ['applinks:rchat.example'],
  }))
  const twice = Bun.YAML.parse(iosShareProject(first))
  expect(twice).toEqual(Bun.YAML.parse(first))
  expect(twice).toMatchObject({
    targets: {
      RChat_iOS: {
        dependencies: [{ sdk: 'UIKit.framework' }, { target: 'RChatShare', embed: true }],
        entitlements: {
          properties: {
            'com.apple.security.application-groups': ['group.io.github.robbyv2.rchat'],
            'com.apple.developer.associated-domains': ['applinks:rchat.example'],
          },
        },
      },
      RChatShare: {
        type: 'app-extension',
        entitlements: {
          properties: {
            'com.apple.security.application-groups': ['group.io.github.robbyv2.rchat'],
          },
        },
        info: {
          properties: { NSExtension: { NSExtensionPointIdentifier: 'com.apple.share-services' } },
        },
      },
    },
  })
})
