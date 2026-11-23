import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import allowances from './fixtures/singletons_allowlist.json'

const app = fileURLToPath(new URL('../../', import.meta.url))
const sideStores = new Set(
  [
    'home_store',
    'palette_store',
    'palette_sync',
    'inbox_source',
    'api_console',
    'ice',
    'rtc',
    'relays',
    'media_src',
    'remote_invite',
    'p2p',
  ].map(name => `lib/${name}.ts`)
)

function findings(file: string, source: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const counts: Record<string, number> = {}
  const record = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  const stores = new Map([
    ['useStore', 'useStore'],
    ['useP2p', 'useP2p'],
  ])
  for (const stmt of tree.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const bindings = stmt.importClause?.namedBindings
    if (!bindings || stmt.importClause?.isTypeOnly) continue
    const instances = /(?:^|\/)instances(?:\.[jt]s)?$/.test(stmt.moduleSpecifier.text)
    if (ts.isNamespaceImport(bindings)) {
      if (instances) record('import *')
      continue
    }
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue
      const name = (binding.propertyName ?? binding.name).text
      if (instances && ['home', 'api', 'registry'].includes(name)) record(`import ${name}`)
      if (name === 'useStore' || name === 'useP2p') stores.set(binding.name.text, name)
    }
  }
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
      const store = ts.isIdentifier(node.expression) && stores.get(node.expression.text)
      if (store && (ts.isPropertyAccessExpression(node) || ts.isStringLiteralLike(key))) {
        const method = (key as ts.Identifier | ts.StringLiteralLike).text
        if (
          method === 'getState' ||
          method === 'setState' ||
          (store === 'useStore' && method === 'subscribe')
        )
          record(`${store}.${method}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (sideStores.has(file) || /^lib\/(?:slices|p2p\/app|client)\//.test(file)) {
    function initializer(node: ts.Node, name: string) {
      if (ts.isFunctionLike(node) || ts.isClassExpression(node)) return
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['Map', 'Set'].includes(node.expression.text)
      )
        record(`new ${node.expression.text} in ${name}`)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'create'
      )
        record(`create in ${name}`)
      ts.forEachChild(node, child => initializer(child, name))
    }
    for (const stmt of tree.statements) {
      if (ts.isExportAssignment(stmt)) initializer(stmt.expression, 'default export')
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(tree)
        if (stmt.declarationList.flags & ts.NodeFlags.Let) record(`let ${name}`)
        if (decl.initializer) initializer(decl.initializer, name)
      }
    }
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map(key => [key, counts[key]])
  )
}

function scan() {
  const baseline: Record<string, Record<string, number>> = {}
  const files = readdirSync(app, { recursive: true, encoding: 'utf8' }).map(path =>
    path.split(sep).join('/')
  )
  for (const file of files.sort()) {
    if (!/\.tsx?$/.test(file) || /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.tsx?$/.test(file))
      continue
    const result = findings(file, readFileSync(`${app}${file}`, 'utf8'))
    if (Object.keys(result).length) baseline[file] = result
  }
  return baseline
}

test('singleton access and module state match their allowances', () => {
  expect(scan()).toEqual(allowances)
}, 60_000)

test('the scan distinguishes module state from state created by a factory', () => {
  const source = `
    import { api as accountApi, type home } from '../instances'
    import { useStore as account } from '../store'
    export default new Map()
    export let counter = 0, names = new Set<string>()
    const cache = create<State>()(() => ({ local: new Map() }))
    function factory() { let fresh = new Map(); return fresh }
    account?.getState(); account['getState'](); useP2p.subscribe(fn)
  `
  expect(findings('lib/client/session.ts', source)).toEqual({
    'import api': 1,
    'new Map in default export': 1,
    'let counter': 1,
    'let names': 1,
    'new Set in names': 1,
    'create in cache': 1,
    'useStore.getState': 2,
  })
  expect(findings('components/page.tsx', source)).toEqual({
    'import api': 1,
    'useStore.getState': 2,
  })
})
