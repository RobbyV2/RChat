import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Who reads the device-local P2P limits (p2p/limits.ts `LOCAL`), found with the type checker over
// the app's sources (tests left out): every property read whose property is declared in the
// registry's defaults, and where the object it is read from comes from. A read from `LOCAL`
// itself is the registry; any other is a reader of the limits a caller handed in (the account's).
// `LOCAL` may only stand in for limits a caller leaves out (a parameter's default, the right of
// `??`, a spread the handed-in limits are spread over), and every call outside the tests hands
// those in. Also every use of `LOCAL` while a module loads, where no account exists yet.

const APP = fileURLToPath(new URL('../../', import.meta.url))
const LIMITS_FILE = join(APP, 'lib/p2p/limits.ts')

export interface Site {
  file: string
  line: number
  text: string
}

export interface LimitScan {
  // Registry name (`section.key`) to the places that read it from limits handed in.
  readers: Map<string, Site[]>
  // A name read from `LOCAL` itself (`LOCAL.calls.ringMs`), anywhere.
  registry: { name: string; at: Site }[]
  // `LOCAL` used while a module loads: a section or a name read, or a constant made from it.
  atLoad: { name: string | null; at: Site }[]
  // `LOCAL` used other than in place of limits a caller can hand in.
  uses: { name: string | null; at: Site }[]
  // What takes limits from its caller instead of `LOCAL`: `fn(param)` or `fn(param.field)`.
  inputs: string[]
  // A call that leaves out limits its callee then takes from `LOCAL`.
  unset: { name: string; at: Site }[]
}

const sources = (dir: string, out: string[] = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (f === '__tests__' || f === 'node_modules') continue
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(f) && !/\.(test|d)\.tsx?$/.test(f)) out.push(p)
  }
  return out
}

const deferred = (n: ts.Node) =>
  ts.isFunctionLike(n) ||
  (ts.isPropertyDeclaration(n) && !n.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword))

const inType = (n: ts.Node): boolean => {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true
    if (ts.isStatement(p) || ts.isClassElement(p)) return false
  }
  return false
}

const atLoad = (n: ts.Node) => {
  for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent)
    if (deferred(p)) return false
  return true
}

const strip = (e: ts.Expression): ts.Expression => {
  while (
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression
  return e
}

const rootOf = (e: ts.Expression): ts.Expression => {
  for (;;) {
    e = strip(e)
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression
    else return e
  }
}

// The whole expression a use of `n` is part of: `LOCAL.calls.ringMs` for `LOCAL`.
const chainOf = (n: ts.Expression) => {
  let e: ts.Expression = n
  for (;;) {
    const p = e.parent
    if (
      ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
        p.expression === e) ||
      ts.isNonNullExpression(p) ||
      ts.isParenthesizedExpression(p)
    )
      e = p
    else return e
  }
}

type Fn = ts.SignatureDeclaration
type Called = ts.CallExpression | ts.NewExpression | ts.JsxOpeningLikeElement

interface Input {
  fn: Fn
  i: number
  prop: string | null
}

// `fixture` scans these sources (path under `app/` to text) with limits.ts instead of the app's.
export const scanLimits = (fixture?: Record<string, string>): LimitScan => {
  const virtual = new Map(Object.entries(fixture ?? {}).map(([f, text]) => [join(APP, f), text]))
  const files = fixture ? [LIMITS_FILE, ...virtual.keys()] : sources(APP)
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    resolveJsonModule: true,
    esModuleInterop: true,
    lib: ['lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.esnext.d.ts'],
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const { fileExists, readFile } = host
  host.fileExists = f => virtual.has(f) || fileExists.call(host, f)
  host.readFile = f => virtual.get(f) ?? readFile.call(host, f)
  const program = ts.createProgram(files, options, host)
  const checker = program.getTypeChecker()
  const lf = program.getSourceFile(LIMITS_FILE)
  if (!lf) throw new Error('limits.ts not in the program')

  // The registry's names, by the declaration of each key in DEFAULTS.
  const names = new Map<ts.Node, string>()
  let local: ts.Symbol | undefined
  const decls = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      if (n.name.text === 'LOCAL') local = checker.getSymbolAtLocation(n.name)
      if (
        n.name.text === 'DEFAULTS' &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      )
        for (const s of n.initializer.properties) {
          if (!ts.isPropertyAssignment(s) || !ts.isObjectLiteralExpression(s.initializer)) continue
          for (const k of s.initializer.properties)
            if (ts.isPropertyAssignment(k))
              names.set(k, `${s.name.getText(lf)}.${k.name.getText(lf)}`)
        }
    }
    n.forEachChild(decls)
  }
  decls(lf)
  if (!local || !names.size) throw new Error('LOCAL or DEFAULTS not found in limits.ts')
  const keys = new Set([...names.values()].map(n => n.split('.')[1]))

  const nameOf = (sym: ts.Symbol | undefined) => {
    for (const d of sym?.declarations ?? []) {
      const n = names.get(d)
      if (n) return n
    }
    return null
  }
  const isLocal = (e: ts.Expression) => {
    if (!ts.isIdentifier(e)) return false
    let s = checker.getSymbolAtLocation(e)
    if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s)
    return s === local
  }
  const mentionsLocal = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && isLocal(n)) || (n.forEachChild(mentionsLocal) ?? false)
  // Whether the file assigns the variable again after it is declared.
  const assigned = (d: ts.VariableDeclaration, sf: ts.SourceFile) => {
    const s = checker.getSymbolAtLocation(d.name)
    const to = (n: ts.Node): boolean => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = strip(n.left)
        if (ts.isIdentifier(l) && checker.getSymbolAtLocation(l) === s) return true
      }
      return n.forEachChild(to) ?? false
    }
    return s !== undefined && to(sf)
  }

  // A parameter `e` names: `deps`, or `this.deps` for a parameter property.
  const paramOf = (e: ts.Expression) => {
    e = strip(e)
    const s = ts.isIdentifier(e)
      ? checker.getSymbolAtLocation(e)
      : ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword
        ? checker.getSymbolAtLocation(e.name)
        : undefined
    const d = s?.valueDeclaration
    return d && ts.isParameter(d) ? d : null
  }
  const inputAt = (p: ts.ParameterDeclaration, prop: string | null): Input => ({
    fn: p.parent,
    i: p.parent.parameters.indexOf(p),
    prop,
  })
  // The input of the enclosing function that `e` hands on: a parameter or a field of one.
  const handed = (e: ts.Expression): Input | null => {
    e = strip(e)
    const p = paramOf(e)
    if (p) return inputAt(p, null)
    if (ts.isPropertyAccessExpression(e)) {
      const q = paramOf(e.expression)
      if (q) return inputAt(q, e.name.text)
    }
    return null
  }
  const deeper = (x: Input | null, prop: string) => (x?.prop === null ? { ...x, prop } : null)

  // Where `n` stands in for limits a caller leaves out: the inputs it stands in for (null for one
  // no caller hands in), or null when it is not such a place.
  const fallbackOf = (n: ts.Node): (Input | null)[] | null => {
    for (let c = n, p = n.parent; p; c = p, p = p.parent) {
      if (ts.isParameter(p)) return p.initializer === c ? [inputAt(p, null)] : null
      if (ts.isBindingElement(p) && p.initializer === c) {
        const key = p.propertyName ?? p.name
        const at = p.parent.parent
        return ts.isParameter(at) && ts.isObjectBindingPattern(p.parent) && ts.isIdentifier(key)
          ? [inputAt(at, key.text)]
          : null
      }
      if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        p.right === c
      )
        return [handed(p.left)]
      if (ts.isSpreadAssignment(p) && c === n) {
        const all = p.parent.properties
        const later = all
          .slice(all.indexOf(p) + 1)
          .filter(ts.isSpreadAssignment)
          .filter(s => !mentionsLocal(s.expression))
        return later.length ? later.map(s => handed(s.expression)) : null
      }
      if (ts.isFunctionLike(p) || ts.isStatement(p) || ts.isClassElement(p)) return null
    }
    return null
  }

  const inputs = new Map<Fn, Map<string, Input>>()
  const addInput = (x: Input) => {
    let m = inputs.get(x.fn)
    if (!m) inputs.set(x.fn, (m = new Map()))
    const k = `${x.i}.${x.prop}`
    if (m.has(k)) return false
    m.set(k, x)
    return true
  }

  const out: LimitScan = {
    readers: new Map(),
    registry: [],
    atLoad: [],
    uses: [],
    inputs: [],
    unset: [],
  }
  const calls: { sf: ts.SourceFile; c: Called }[] = []
  const siteIn = (sf: ts.SourceFile, n: ts.Node): Site => ({
    file: relative(APP, sf.fileName),
    line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
    text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80),
  })
  for (const sf of program.getSourceFiles()) {
    if (!files.includes(sf.fileName) || sf.fileName === LIMITS_FILE) continue
    const site = (n: ts.Node) => siteIn(sf, n)
    const read = (name: string, root: ts.Expression, n: ts.Node) => {
      if (isLocal(root)) out.registry.push({ name, at: site(n) })
      else {
        const l = out.readers.get(name) ?? []
        l.push(site(n))
        out.readers.set(name, l)
      }
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isJsxOpeningLikeElement(n))
        calls.push({ sf, c: n })
      if (ts.isPropertyAccessExpression(n) && keys.has(n.name.text) && !inType(n)) {
        const name = nameOf(checker.getSymbolAtLocation(n.name))
        if (name) read(name, rootOf(n.expression), n)
      } else if (
        ts.isBindingElement(n) &&
        !n.dotDotDotToken &&
        ts.isObjectBindingPattern(n.parent) &&
        ts.isVariableDeclaration(n.parent.parent) &&
        n.parent.parent.initializer
      ) {
        const key = n.propertyName ?? n.name
        if (ts.isIdentifier(key) && keys.has(key.text)) {
          const prop = checker.getTypeAtLocation(n.parent).getProperty(key.text)
          const name = nameOf(prop)
          if (name) read(name, rootOf(n.parent.parent.initializer), n)
        }
      } else if (ts.isIdentifier(n) && n.text === 'LOCAL' && !inType(n) && isLocal(n)) {
        const p = n.parent
        if (
          !ts.isImportSpecifier(p) &&
          !ts.isExportSpecifier(p) &&
          !(ts.isPropertyAccessExpression(p) && p.name === n)
        ) {
          // Only a module's holder the account's limits replace later may start as the registry
          // (`let limits = LOCAL`, then `limits = x`); a read of a name is reported with it.
          const holder =
            ts.isVariableDeclaration(p) &&
            p.initializer === n &&
            (ts.getCombinedNodeFlags(p) & ts.NodeFlags.Let) !== 0 &&
            atLoad(n) &&
            assigned(p, sf)
          const name =
            ts.isPropertyAccessExpression(p) && ts.isPropertyAccessExpression(p.parent)
              ? nameOf(checker.getSymbolAtLocation(p.parent.name))
              : null
          if (!holder && atLoad(n)) out.atLoad.push({ name, at: site(p) })
          const whole = chainOf(n)
          const fallback = holder ? [] : fallbackOf(whole)
          if (!fallback || fallback.some(x => !x)) out.uses.push({ name, at: site(whole) })
          for (const x of fallback ?? []) if (x) addInput(x)
        }
      }
      n.forEachChild(visit)
    }
    visit(sf)
  }

  const decl = new Map<Called, Fn | undefined>()
  const declOf = (c: Called) => {
    if (!decl.has(c)) {
      const d = checker.getResolvedSignature(c)?.declaration
      decl.set(c, d && !ts.isJSDocSignature(d) ? d : undefined)
    }
    return decl.get(c)
  }
  const maybeUndefined = (t: ts.Type) =>
    (t.flags & ts.TypeFlags.Undefined) !== 0 ||
    (t.isUnion() && t.types.some(u => (u.flags & ts.TypeFlags.Undefined) !== 0))
  const argsOf = (c: Called): readonly (ts.Expression | ts.JsxAttributes)[] =>
    ts.isJsxOpeningLikeElement(c) ? [c.attributes] : (c.arguments ?? [])
  const unsetValue = (e: ts.Expression) => {
    const s = strip(e)
    return (ts.isIdentifier(s) && s.text === 'undefined') || ts.isVoidExpression(s)
  }
  // What an argument hands in for a field: 'gone' when the field is left out or written as
  // `undefined`, the caller's input it hands on when it may be missing, or null for a value.
  type Field = Input | 'gone' | null
  const valueOf = (e: ts.Expression): Field =>
    unsetValue(e) ? 'gone' : maybeUndefined(checker.getTypeAtLocation(e)) ? handed(e) : null
  const carried = (e: ts.Expression, prop: string): Field | undefined => {
    const t = checker.getTypeAtLocation(e)
    const p = checker.getNonNullableType(t).getProperty(prop)
    if (!p) return undefined
    return maybeUndefined(t) ||
      p.flags & ts.SymbolFlags.Optional ||
      maybeUndefined(checker.getTypeOfSymbolAtLocation(p, e))
      ? deeper(handed(e), prop)
      : null
  }
  const fieldOf = (a: ts.Expression | ts.JsxAttributes, prop: string): Field => {
    const s = ts.isJsxAttributes(a) ? a : strip(a)
    if (!ts.isObjectLiteralExpression(s) && !ts.isJsxAttributes(s)) {
      const f = carried(s, prop)
      return f === undefined ? 'gone' : f
    }
    for (const q of [...s.properties].reverse()) {
      if (ts.isSpreadAssignment(q) || ts.isJsxSpreadAttribute(q)) {
        const f = carried(q.expression, prop)
        if (f !== undefined) return f
      } else if (q.name?.getText() === prop) {
        if (ts.isPropertyAssignment(q)) return valueOf(q.initializer)
        if (ts.isShorthandPropertyAssignment(q)) return valueOf(q.name)
        if (ts.isJsxAttribute(q) && q.initializer && ts.isJsxExpression(q.initializer))
          return q.initializer.expression ? valueOf(q.initializer.expression) : 'gone'
        return null
      }
    }
    return 'gone'
  }
  // The inputs of the callee that the call leaves out (`gone`), and the inputs of the caller it
  // hands on to the callee, which may be left out too (`on`).
  const check = (c: Called) => {
    const gone: Input[] = []
    const on: Input[] = []
    const d = declOf(c)
    const args = argsOf(c)
    for (const x of (d && inputs.get(d)?.values()) ?? []) {
      if (args.slice(0, x.i + 1).some(a => ts.isSpreadElement(a))) continue
      const a = args[x.i]
      const f = !a
        ? 'gone'
        : x.prop !== null
          ? fieldOf(a, x.prop)
          : ts.isJsxAttributes(a)
            ? null
            : valueOf(a)
      if (f === 'gone') gone.push(x)
      else if (f) on.push(f)
    }
    return { gone, on }
  }
  const nameIn = (x: Input) => {
    const fn = x.fn
    const owner = ts.isConstructorDeclaration(fn)
      ? `new ${fn.parent.name?.text ?? '(class)'}`
      : (fn.name ?? (fn.parent as { name?: ts.Node }).name)?.getText()
    const p = fn.parameters[x.i]
    return `${owner}(${p ? p.name.getText() : x.i}${x.prop === null ? '' : `.${x.prop}`})`
  }

  // Inputs left out inside a fallback, or handed on from the caller's own, become the caller's.
  for (let grew = true; grew;) {
    grew = false
    for (const { c } of calls) {
      const { gone, on } = check(c)
      for (const x of on) grew = addInput(x) || grew
      if (!gone.length) continue
      for (const x of fallbackOf(c) ?? []) if (x) grew = addInput(x) || grew
    }
  }
  for (const { sf, c } of calls) {
    const { gone } = check(c)
    if (!gone.length) continue
    const fallback = fallbackOf(c)
    if (fallback && fallback.every(Boolean)) continue
    for (const x of gone) out.unset.push({ name: nameIn(x), at: siteIn(sf, c) })
  }
  // A function with an input of its own passed to be called by something else, with arguments
  // it doesn't know.
  for (const { sf, c } of calls) {
    if (ts.isJsxOpeningLikeElement(c)) continue
    for (const a of c.arguments ?? []) {
      const s = strip(a)
      if (!ts.isIdentifier(s) && !ts.isPropertyAccessExpression(s)) continue
      let sym = checker.getSymbolAtLocation(ts.isIdentifier(s) ? s : s.name)
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
      const v = sym?.valueDeclaration
      const fn =
        v && ts.isVariableDeclaration(v) && v.initializer && ts.isFunctionLike(v.initializer)
          ? v.initializer
          : v && ts.isFunctionLike(v)
            ? v
            : undefined
      for (const x of (fn && inputs.get(fn)?.values()) ?? [])
        if (x.prop === null) out.unset.push({ name: nameIn(x), at: siteIn(sf, a) })
    }
  }
  for (const m of inputs.values()) for (const x of m.values()) out.inputs.push(nameIn(x))
  return out
}
