import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { importsOf, packagesOf } from './import_graph'

// Which P2P modules may load which (static imports, type-only ones aside).

const P2P = 'apps/web/app/lib/p2p'
const SERVER = fileURLToPath(new URL('../p2p/server/', import.meta.url))

// What plan H's reports may import without the page: every server module and the transport.
const PAGE_FREE = () => [
  ...readdirSync(SERVER)
    .filter(f => f.endsWith('.ts'))
    .map(f => `${P2P}/server/${f}`),
  ...['node.ts', 'session.ts', 'gossip.ts', 'sync.ts'].map(f => `${P2P}/${f}`),
]
const PAGE_FILE = (p: string) => p.startsWith(`${P2P}/app/`) || p === 'apps/web/app/lib/store.ts'
const PAGE_PACKAGE = (p: string) => /^(react|zustand)(\/|$)/.test(p)

// Who writes each part of a room's runtime record (server/rt.ts): storage and the member lists
// have one writer; the other parts list theirs.
const WRITERS: Record<string, string[]> = {
  SyncRt: ['codes.ts', 'index.ts', 'load.ts', 'receive.ts', 'storage.ts', 'transfer.ts'],
  StoreRt: ['storage.ts'],
  ModRt: ['devices.ts', 'load.ts', 'moderation.ts'],
  XferRt: ['devices.ts', 'load.ts', 'transfer.ts'],
  ViewRt: ['index.ts'],
}

const TSCONFIG = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

// The parts of the runtime record, and which server files write a field of each: assignments of
// any operator, `++`, `--` and `delete`, through any receiver, as the type checker resolves them.
const runtimeWrites = () => {
  const cfg = ts.readConfigFile(TSCONFIG, ts.sys.readFile)
  const { options } = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(TSCONFIG))
  const files = readdirSync(SERVER)
    .filter(f => f.endsWith('.ts'))
    .map(f => join(SERVER, f))
  const program = ts.createProgram(files, { ...options, noEmit: true, incremental: false })
  const checker = program.getTypeChecker()
  const parts = new Set<ts.Symbol>()
  ts.forEachChild(program.getSourceFile(join(SERVER, 'rt.ts'))!, n => {
    if (ts.isInterfaceDeclaration(n) && n.name.text !== 'Rt')
      parts.add(checker.getSymbolAtLocation(n.name)!)
  })
  const found: Record<string, Set<string>> = {}
  const assigns = (k: ts.SyntaxKind) =>
    k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment
  for (const file of files) {
    const visit = (n: ts.Node) => {
      let target: ts.Node | undefined
      if (ts.isBinaryExpression(n) && assigns(n.operatorToken.kind)) target = n.left
      else if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      )
        target = n.operand
      else if (ts.isDeleteExpression(n)) target = n.expression
      if (
        target &&
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
      ) {
        const key = ts.isPropertyAccessExpression(target) ? target.name : target.argumentExpression
        const owner = checker.getSymbolAtLocation(key)?.declarations?.[0]?.parent
        if (owner && ts.isInterfaceDeclaration(owner)) {
          const sym = checker.getSymbolAtLocation(owner.name)
          if (sym && parts.has(sym)) (found[owner.name.text] ??= new Set()).add(basename(file))
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(program.getSourceFile(file)!)
  }
  return {
    parts: [...parts].map(p => p.name).sort(),
    writers: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()])),
  }
}

const reaches = (g: Set<string>, m: string) => [...g].some(p => p.endsWith(m))

describe('P2P layering', () => {
  test('the walker follows value imports and skips type-only ones', () => {
    const g = importsOf(`${P2P}/acl/rules.ts`)
    expect(g.has(`${P2P}/limits.ts`)).toBe(true)
    expect(g.has(`${P2P}/canonical.ts`)).toBe(true)
    expect(g.has(`${P2P}/acl/facts.ts`)).toBe(false)
  })

  test('the summary codec loads without the evaluator', () => {
    const g = importsOf(`${P2P}/acl/summary.ts`)
    for (const m of ['acl/eval.ts', 'acl/cache.ts', 'acl/admit.ts', 'acl_room.ts'])
      expect([m, reaches(g, m)]).toEqual([m, false])
  })

  test('the server code and the transport load without the page store, zustand or React', () => {
    for (const entry of PAGE_FREE()) {
      const files = [...importsOf(entry)].filter(PAGE_FILE)
      const packages = [...packagesOf(entry)].filter(PAGE_PACKAGE)
      expect([entry, files, packages]).toEqual([entry, [], []])
    }
  })

  test('transfer works without the views', () =>
    expect(reaches(importsOf(`${P2P}/server/transfer.ts`), 'server/views.ts')).toBe(false))

  test('each part of the runtime record is written only by the modules that own it', () => {
    const { parts, writers } = runtimeWrites()
    expect(parts).toEqual(Object.keys(WRITERS).sort())
    expect(writers).toEqual(WRITERS)
  }, 120_000)

  test('the page store loads no other part of the P2P app', () =>
    expect([...importsOf(`${P2P}/app/store.ts`)].filter(p => p.startsWith(`${P2P}/app/`))).toEqual(
      []
    ))
})
