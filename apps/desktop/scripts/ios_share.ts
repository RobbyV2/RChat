// Extend the generated XcodeGen spec. Preserve its signing, plist and associated-domain settings.
type Target = {
  type: string
  platform: string
  info?: { path: string; properties?: Record<string, unknown> }
  entitlements?: { path: string; properties?: Record<string, unknown> }
  dependencies?: { target?: string; embed?: boolean }[]
  [key: string]: unknown
}
type Project = {
  targets: Record<string, Target>
  settingGroups: { app: { base: Record<string, string> } }
}
const group = 'group.io.github.robbyv2.rchat'
export function iosShareProject(
  spec: string,
  existing: (path: string) => Record<string, unknown> = () => ({})
) {
  const project = Bun.YAML.parse(spec) as Project
  const app = Object.values(project.targets).find(
    t => t.type === 'application' && t.platform === 'iOS'
  )
  if (!app?.entitlements || !app.info) throw Error('No generated iOS app target')
  const props = (app.entitlements.properties = {
    ...existing(app.entitlements.path),
    ...app.entitlements.properties,
  })
  const groups = (props['com.apple.security.application-groups'] ?? []) as string[]
  props['com.apple.security.application-groups'] = [...new Set([...groups, group])]
  const target = 'RChatShare'
  app.dependencies = [
    ...(app.dependencies ?? []).filter(d => d.target !== target),
    { target, embed: true },
  ]
  const appInfo = app.info.path
  const source = 'ShareExtension'
  const extInfo = source + '/Info.plist'
  project.targets[target] = {
    type: 'app-extension',
    platform: 'iOS',
    sources: [{ path: source, excludes: ['*.plist', '*.entitlements'] }],
    settings: {
      groups: ['app'],
      base: {
        PRODUCT_NAME: target,
        PRODUCT_BUNDLE_IDENTIFIER: 'io.github.robbyv2.rchat.share',
        SKIP_INSTALL: 'YES',
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        SWIFT_VERSION: '5.0',
      },
    },
    entitlements: {
      path: source + '/Share.entitlements',
      properties: { 'com.apple.security.application-groups': [group] },
    },
    info: {
      path: extInfo,
      properties: {
        CFBundleDisplayName: 'RChat',
        CFBundleShortVersionString: app.info.properties?.CFBundleShortVersionString,
        CFBundleVersion: app.info.properties?.CFBundleVersion,
        NSExtension: {
          NSExtensionPointIdentifier: 'com.apple.share-services',
          NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
          NSExtensionAttributes: {
            NSExtensionActivationRule: {
              NSExtensionActivationSupportsText: true,
              NSExtensionActivationSupportsWebURLWithMaxCount: 8,
              NSExtensionActivationSupportsFileWithMaxCount: 8,
              NSExtensionActivationSupportsImageWithMaxCount: 8,
              NSExtensionActivationSupportsMovieWithMaxCount: 8,
            },
          },
        },
      },
    },
    preBuildScripts: [
      {
        name: 'Match containing app version',
        inputFiles: ['$(SRCROOT)/' + appInfo],
        outputFiles: ['$(SRCROOT)/' + extInfo],
        basedOnDependencyAnalysis: false,
        script: [
          'set -eu',
          'for key in CFBundleVersion CFBundleShortVersionString; do',
          '  value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$SRCROOT/' + appInfo + '")',
          '  /usr/libexec/PlistBuddy -c "Set :$key $value" "$SRCROOT/' + extInfo + '"',
          'done',
        ].join('\n'),
      },
    ],
  }
  return Bun.YAML.stringify(project)
}
