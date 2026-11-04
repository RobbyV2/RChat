import { readFileSync } from 'node:fs'
import ts from 'typescript'

// The surface a module offers, read from its source: the names it exports (values and types
// apart), and a class's public members. For tests that a split keeps the surface.

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

const has = (n: ts.Node, k: ts.SyntaxKind) =>
  (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some(m => m.kind === k) ?? false

// The type-only names a module exports (interfaces, type aliases, `export type`). Values are read
// at run time from the module itself.
export const typeExportsOf = (file: string): string[] => {
  const out = new Set<string>()
  for (const s of parse(file).statements) {
    if (
      (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) &&
      has(s, ts.SyntaxKind.ExportKeyword)
    )
      out.add(s.name.text)
    if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause))
      for (const e of s.exportClause.elements)
        if (s.isTypeOnly || e.isTypeOnly) out.add(e.name.text)
  }
  return [...out].sort()
}

// The public members of class `name` in `file`: methods, accessors and properties without
// `private` or `protected` (constructor parameter properties included).
export const publicMembersOf = (file: string, name: string): string[] => {
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === name)
      for (const m of n.members) {
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters)
            if (
              ts.isIdentifier(p.name) &&
              (has(p, ts.SyntaxKind.PublicKeyword) || has(p, ts.SyntaxKind.ReadonlyKeyword)) &&
              !has(p, ts.SyntaxKind.PrivateKeyword) &&
              !has(p, ts.SyntaxKind.ProtectedKeyword)
            )
              out.add(p.name.text)
          continue
        }
        if (has(m, ts.SyntaxKind.PrivateKeyword) || has(m, ts.SyntaxKind.ProtectedKeyword)) continue
        if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.add(m.name.text)
      }
    ts.forEachChild(n, visit)
  }
  visit(parse(file))
  return [...out].sort()
}
