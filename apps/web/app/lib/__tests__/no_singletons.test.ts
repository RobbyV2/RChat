import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

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
  type StoreValue = 'namespace' | 'useStore' | 'useP2p'
  const bindings = new Map<ts.Declaration, StoreValue>()
  // Resolve identifiers inside this file only. Import aliases stay distinct from
  // parameters and local declarations with the same spelling.
  const options: ts.CompilerOptions = { noResolve: true, noLib: true }
  let checker: ts.TypeChecker | undefined
  const declaration = (id: ts.Identifier) => {
    checker ??= ts
      .createProgram([file], options, {
        ...ts.createCompilerHost(options),
        getSourceFile: name => (name === file ? tree : undefined),
      })
      .getTypeChecker()
    return checker.getSymbolAtLocation(id)?.declarations?.[0]
  }
  const storeModule = (path: string) =>
    /(?:^|\/)(?:store|(?:client\/)?(?:react|p2p_react)|p2p\/app(?:\/index)?)$/.test(
      path.replace(/\.[cm]?[jt]sx?$/, '')
    )
  const hook = (name: string) => name === 'useStore' || name === 'useP2p'
  function loadedStore(expr: ts.Expression): boolean {
    if (
      ts.isAwaitExpression(expr) ||
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      return loadedStore(expr.expression)
    if (!ts.isCallExpression(expr)) return false
    const loader = expr.expression
    const path = expr.arguments[0]
    return (
      (loader.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(loader) && loader.text === 'require' && !declaration(loader))) &&
      !!path &&
      ts.isStringLiteralLike(path) &&
      storeModule(path.text)
    )
  }
  function bindModule(binding: ts.VariableDeclaration | ts.ParameterDeclaration) {
    if (ts.isIdentifier(binding.name)) bindings.set(binding, 'namespace')
    if (!ts.isObjectBindingPattern(binding.name)) return
    for (const element of binding.name.elements) {
      const key = element.propertyName ?? element.name
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && hook(key.text))
        bindings.set(element, key.text)
    }
  }
  function collectLoads(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && loadedStore(node.initializer))
      bindModule(node)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      loadedStore(node.expression.expression)
    ) {
      const callback = node.arguments[0]
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0]
      )
        bindModule(callback.parameters[0])
    }
    ts.forEachChild(node, collectLoads)
  }
  collectLoads(tree)
  for (const stmt of tree.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const imported = stmt.importClause?.namedBindings
    if (!imported || stmt.importClause?.isTypeOnly) continue
    const instances = /(?:^|\/)instances(?:\.[jt]s)?$/.test(stmt.moduleSpecifier.text)
    const fromStore = storeModule(stmt.moduleSpecifier.text)
    if (ts.isNamespaceImport(imported)) {
      if (fromStore) bindings.set(imported, 'namespace')
      if (instances) record('import *')
      continue
    }
    for (const binding of imported.elements) {
      if (binding.isTypeOnly) continue
      const name = (binding.propertyName ?? binding.name).text
      if (instances && ['home', 'api', 'registry'].includes(name)) record(`import ${name}`)
      if (fromStore && hook(name)) bindings.set(binding, name)
    }
  }
  function member(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    return ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined
  }
  function value(expr: ts.Expression, seen: Set<ts.Declaration>): StoreValue | undefined {
    if (loadedStore(expr)) return 'namespace'
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      return value(expr.expression, seen)
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const name = member(expr)
      if (name && hook(name) && value(expr.expression, seen) === 'namespace') return name
      return
    }
    if (!ts.isIdentifier(expr)) return
    const decl = declaration(expr)
    if (!decl || seen.has(decl)) return
    const known = bindings.get(decl)
    if (known) return known
    seen.add(decl)
    if (ts.isVariableDeclaration(decl) && decl.initializer) return value(decl.initializer, seen)
    if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
      const name = decl.propertyName ?? decl.name
      const container = decl.parent.parent
      if (
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        hook(name.text) &&
        ts.isVariableDeclaration(container) &&
        container.initializer &&
        value(container.initializer, seen) === 'namespace'
      )
        return name.text
    }
  }
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const method = member(node)
      if (method === 'getState' || method === 'setState' || method === 'subscribe') {
        const store = value(node.expression, new Set())
        if (store && store !== 'namespace' && (method !== 'subscribe' || store === 'useStore'))
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

// Account state lives in the per-account session factories: no module keeps state of its own
// or reaches an account's store from outside one.
test('no module holds state outside a factory or reaches a store as a singleton', () => {
  expect(scan()).toEqual({})
}, 60_000)

test('the scan distinguishes module state from state created by a factory', () => {
  const source = `
    import { api as accountApi, type home } from '../instances'
    import { useStore as account } from '../store'
    import * as peer from '../p2p/app'
    function scoped(account: any, peer: any) { account.getState(); peer.useP2p.setState({}) }
    { const account = scopedStore(); account.getState() }
    function make(scope: any) { const {useP2p} = scope; return useP2p.getState() }
    peer.useP2p.setState({})
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
    'useP2p.setState': 1,
  })
  expect(findings('components/page.tsx', source)).toEqual({
    'import api': 1,
    'useStore.getState': 2,
    'useP2p.setState': 1,
  })
})

test('explicit extensions and deferred hook imports retain their owner', () => {
  const source = `
    import { useStore as chat } from '../store.js'
    chat.getState()
    import('../store').then(({ useStore }) => useStore.getState().logout())
    import('../client/p2p_react.tsx').then(mod => mod.useP2p.getState())
    async function open() {
      const { useStore: current } = await import('../client/react.js')
      current.setState({})
      ;(await import('../p2p/app/index.js')).useP2p.getState()
    }
    const alias = chat
    alias.getState()
    const ns = require('../store')
    const {useStore: another} = ns
    another.subscribe(fn)
    function local(require: any) {
      const {useStore} = require('../store')
      useStore.getState()
    }
    function handle(useStore: any) { useStore.getState() }
  `
  expect(findings('components/deferred.tsx', source)).toEqual({
    'useStore.getState': 3,
    'useStore.subscribe': 1,
    'useStore.setState': 1,
    'useP2p.getState': 2,
  })
})
