import { describe, expect, test } from 'bun:test'
import {
  addr,
  FALLBACK_FUNCTIONS,
  FallbackSheet,
  formatGeneral,
  NEEDS_WASM,
  show,
} from '../apps/sheet/formula'
import bounds from './apps_vectors/formula_bounds.json'
import cycles from './apps_vectors/formula_cycles.json'
import edges from './apps_vectors/formula_edges.json'
import mixed from './apps_vectors/formula_mixed.json'
import random from './apps_vectors/formula_random.json'
import vectors from './apps_vectors/formulas.json'

type Cell = [number, number, string]

// Two answers are the same when they are the same text.
const same = (a: string, b: string) => a === b

const sheet = (grid: Cell[]) => {
  const f = new FallbackSheet()
  for (const [r, c, v] of grid) f.set(r, c, v)
  return f
}

const GRID: Cell[] = [
  [1, 1, '1'],
  [1, 2, 'apple'],
  [1, 3, '10'],
  [2, 1, '2'],
  [2, 2, 'pear'],
  [2, 3, '20'],
  [3, 1, '3'],
  [3, 2, 'Apple'],
  [3, 3, '30'],
  [4, 1, 'TRUE'],
  [4, 3, '2.5'],
]

const at = (formula: string) => {
  const f = sheet(GRID)
  f.set(9, 9, formula)
  return show(f.value(9, 9))
}

// What the fallback leaves to the full engine in the edge set: it says so instead of guessing.
const DEFERRED = [
  '=2^0.5',
  '=10%^2',
  '=2^1%',
  '=SUMIF(A1:A3,">a",C1:C3)',
  '=SUMIF(B1:B3,">a",C1:C3)',
  '=SUMIF(A1:A4,">a")',
  '=(-8)^0.5',
  '=1e308*10-1e308*10',
  '=A1:A3',
  '=A1:A3+1',
  '=IF(A1:A3,1,2)',
  '=-A1:A3',
  '=LEN(A1:A3)',
  '=ABS(A1:A3)',
  '=SUM(A:A)',
  '=SUM(1:1)',
  '={1,2}',
  '=SQRT(4)',
  '=VLOOKUP(2,A1:C3,2)',
  '=VLOOKUP(2,A1:C3,2,TRUE)',
  '=SUMIF(B1:B3,"a*",C1:C3)',
  '=SUMIF(B1:B3,"?pple",C1:C3)',
  '=SUMIF(B1:B3,"~*",C1:C3)',
  '=1+',
  '=(1',
  '=1 2',
  '=#',
  '="0x10"+1',
  '="1,000"+1',
  '="$5"+1',
  '="50%"+1',
  '="2026-01-02"+1',
  '="-"+1',
  '=IFERROR(SQRT(4),"x")',
  '=COUNT(A1:A3,SQRT(4))',
]

const MIXED_CASES = 318
const MIXED_DEFERRED = [
  '=+A1:A3',
  '=SUMIF(A1:A3,">1",C1:C2)',
  '=SUMIF(A1:A3,">1",C1:D1)',
  '=SUMIF(A1:B5,"",C1:D5)',
  '=SUMIF(A1:A4,Z9,C1:C4)',
  '=SUMIF(A1:A5,Z9,C1:C5)',
  '=SUMIF(B1:B4,">b",C1:C4)',
  '=SUMIF(B1:B4,"<b",C1:C4)',
  '=SUMIF(B1:B4,">=apple",C1:C4)',
  '=SUMIF(A1:C4,">w")',
  '=SUMIF(A1:A3,D1,C1:C3)',
  '=SUMIF(A1:A3,A1:A3)',
  '=SUMIF(A1:A3,"> 1")',
  '=SUMIF(A1:A3,">")',
  '=SUMIF(A1:A3,"<")',
  '=SUMIF(B1:B3,">")',
  '=SUMIF(A1:B4,"<=")',
  '=VLOOKUP(2,A1:C3,2,"x")',
  '=VLOOKUP(2,A1:C3,2,D1)',
  '=VLOOKUP(2,A1:C3,2,"FALSE")',
  '=VLOOKUP(2,A1:C3,2,Z9)',
  '=VLOOKUP(2,A1,1,FALSE)',
  '=VLOOKUP(2,5,1,FALSE)',
  '=LEN(-ROUND(29,-2))',
  '=LEN(0*-1)',
  '=(0*-1)&""',
  '=-ROUND(29,-2)&""',
  '=ROUND(-0.4,0)&"x"',
  '=1e21&""',
  '=123456789012345678&""',
  '=1e-7&""',
  '=1.5e-10&""',
  '=UPPER(1e-7)',
  '=COUNT("$5")',
  '=COUNT("1,000")',
  '=COUNT("50%")',
  '=IFERROR(E5,"na")',
  '=(-8)^(1/3)',
  '=2^0.5^2',
]
const RANDOM_DEFERRED = 121
const CYCLE_CELLS = 3993
const CYCLE_CIRCLES = 196
const CYCLE_DEFERRED = 270
const BOUNDS_DEFERRED = 312
const TYPED_DEFERRED = 387

describe('the recorded answers of the full engine', () => {
  test('the vectors are 2,000 formulas over a 30 by 5 grid, answered by IronCalc 0.9.1', () => {
    expect(vectors.engine).toBe('ironcalc 0.9.1')
    expect(vectors.grid.length).toBe(150)
    expect(vectors.cases.length).toBe(2000)
    expect(vectors.column).toBe(6)
  })

  test('the fallback agrees on all 2,000', () => {
    const f = sheet(vectors.grid as Cell[])
    const differ: string[] = []
    vectors.cases.forEach((x, i) => {
      const row = 1 + (i % 30)
      f.set(row, vectors.column, x.formula)
      const got = show(f.value(row, vectors.column))
      if (!same(x.ironcalc, got)) differ.push(`${x.formula} is ${x.ironcalc}, not ${got}`)
      f.set(row, vectors.column, '')
    })
    expect(differ).toEqual([])
  })

  test('on the edge set it agrees or says it needs WebAssembly, never a third answer', () => {
    expect(edges.engine).toBe('ironcalc 0.9.1')
    expect(edges.grid).toEqual(GRID)
    expect(edges.cases.length).toBe(276)
    const f = sheet(edges.grid as Cell[])
    const differ: string[] = []
    const deferred: string[] = []
    edges.cases.forEach((x, i) => {
      const row = 11 + i
      f.set(row, edges.column, x.formula)
      const got = show(f.value(row, edges.column))
      if (got === NEEDS_WASM) deferred.push(x.formula)
      else if (!same(x.ironcalc, got)) differ.push(`${x.formula} is ${x.ironcalc}, not ${got}`)
      f.set(row, edges.column, '')
    })
    expect(differ).toEqual([])
    expect(deferred).toEqual(DEFERRED)
  })

  test('over cells that hold errors, formulas and text it agrees or says it needs WebAssembly', () => {
    expect(mixed.engine).toBe('ironcalc 0.9.1')
    expect(mixed.grid.length).toBe(23)
    expect(mixed.cases.length).toBe(MIXED_CASES)
    const f = sheet(mixed.grid as Cell[])
    const differ: string[] = []
    const deferred: string[] = []
    for (const x of mixed.cases) {
      f.set(mixed.row, mixed.column, x.formula)
      const got = show(f.value(mixed.row, mixed.column))
      if (got === NEEDS_WASM) deferred.push(x.formula)
      else if (!same(x.ironcalc, got)) differ.push(`${x.formula} is ${x.ironcalc}, not ${got}`)
    }
    expect(differ).toEqual([])
    expect(deferred).toEqual(MIXED_DEFERRED)
  })

  test('on 2,000 wider random formulas it agrees or says it needs WebAssembly', () => {
    expect(random.engine).toBe('ironcalc 0.9.1')
    expect(random.grid.length).toBe(150)
    expect(random.cases.length).toBe(2000)
    const f = sheet(random.grid as Cell[])
    const differ: string[] = []
    let deferred = 0
    random.cases.forEach((x, i) => {
      const row = 1 + (i % 30)
      f.set(row, random.column, x.formula)
      const got = show(f.value(row, random.column))
      if (got === NEEDS_WASM) deferred++
      else if (!same(x.ironcalc, got)) differ.push(`${x.formula} is ${x.ironcalc}, not ${got}`)
      f.set(row, random.column, '')
    })
    expect(differ).toEqual([])
    expect(deferred).toBe(RANDOM_DEFERRED)
  })

  test('at the bounds of a number and on errors it shows the same text or says it needs WebAssembly', () => {
    expect(bounds.engine).toBe('ironcalc 0.9.1')
    expect(bounds.cases.length).toBe(933)
    const differ: string[] = []
    let deferred = 0
    for (const x of bounds.cases) {
      const f = sheet(bounds.grid as Cell[])
      f.set(bounds.row, bounds.column, x.formula)
      const got = show(f.value(bounds.row, bounds.column))
      if (got === NEEDS_WASM) deferred++
      else if (!same(x.ironcalc, got)) differ.push(`${x.formula} is ${x.ironcalc}, not ${got}`)
    }
    expect(differ).toEqual([])
    expect(deferred).toBe(BOUNDS_DEFERRED)
  })

  test('what is typed into a cell is read as the full engine reads it, or needs WebAssembly', () => {
    const { typed } = bounds
    expect(typed.inputs.length).toBe(136)
    const differ: string[] = []
    let deferred = 0
    for (const x of typed.inputs) {
      const f = sheet(typed.grid as Cell[])
      f.set(typed.row, typed.column, x.input)
      typed.asks.forEach((ask, i) => {
        f.set(20, 9, ask)
        const got = show(f.value(20, 9))
        if (got === NEEDS_WASM) deferred++
        else if (!same(x.answers[i], got))
          differ.push(`${JSON.stringify(x.input)}: ${ask} is ${x.answers[i]}, not ${got}`)
      })
    }
    expect(differ).toEqual([])
    expect(deferred).toBe(TYPED_DEFERRED)
  })
})

// Every index of a list of n, in an order that is the same on every run.
const shuffled = (n: number, seed: number) => {
  const out = [...Array(n).keys()]
  let x = seed
  for (let i = n - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648
    const j = x % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// What every cell of a grid shows, asked in the given order.
const answers = (grid: Cell[], order: number[]) => {
  const f = sheet(grid)
  const out: string[] = []
  for (const i of order) out[i] = show(f.value(grid[i][0], grid[i][1]))
  return out
}

describe('cells that read the cells being computed', () => {
  test('on sheets whose formulas read the ranges they are in, it agrees or needs WebAssembly, whatever is asked first', () => {
    expect(cycles.engine).toBe('ironcalc 0.9.1')
    expect(cycles.sheets.length).toBe(120)
    const differ: string[] = []
    let cells = 0
    let circles = 0
    let deferred = 0
    cycles.sheets.forEach(({ grid, shown }, k) => {
      const n = grid.length
      const orders = [[...Array(n).keys()], [...Array(n).keys()].reverse(), shuffled(n, k + 1)]
      const [first, ...rest] = orders.map(order => answers(grid as Cell[], order))
      shown.forEach((ironcalc, i) => {
        cells++
        if (ironcalc === '#CIRC!') circles++
        const got = first[i]
        if (rest.some(other => other[i] !== got))
          differ.push(`sheet ${k}, ${grid[i]}: depends on the order`)
        if (got === NEEDS_WASM) deferred++
        else if (!same(ironcalc, got))
          differ.push(`sheet ${k}, ${grid[i]} is ${ironcalc}, not ${got}`)
      })
    })
    expect(differ).toEqual([])
    expect([cells, circles, deferred]).toEqual([CYCLE_CELLS, CYCLE_CIRCLES, CYCLE_DEFERRED])
  })

  test('a formula that reads itself, through a range or another cell, needs WebAssembly', () => {
    const cases: [Cell[], number[]][] = [
      [
        [
          [1, 9, '5'],
          [2, 9, '6'],
          [20, 9, '=COUNT(I1:I20)'],
        ],
        [2],
      ],
      [[[20, 9, '=IFERROR(I20+1,0)']], [0]],
      [
        [
          [1, 9, '5'],
          [2, 9, '6'],
          [20, 9, '=VLOOKUP(3,I1:J20,1,FALSE)'],
        ],
        [2],
      ],
      [
        [
          [1, 1, '1'],
          [2, 1, '=SUM(A1:A3)'],
          [3, 1, '=A2'],
        ],
        [1, 2],
      ],
    ]
    for (const formula of [
      '=IFERROR(D1,7)',
      '=COUNT(D1)',
      '=COUNTA(I20)',
      '=LEN(IFERROR(I20,"ab"))',
      '=SUM(1,IFERROR(I20,1))',
    ])
      cases.push([
        [
          [1, 4, '=I20'],
          [20, 9, formula],
        ],
        [0, 1],
      ])
    for (const [grid, circle] of cases)
      for (const order of [[...grid.keys()], [...grid.keys()].reverse()]) {
        const got = answers(grid, order)
        expect({ grid, circle: circle.map(i => got[i]) }).toEqual({
          grid,
          circle: circle.map(() => NEEDS_WASM),
        })
      }
  })

  test('what a cell shows never depends on which cell was asked first', () => {
    const grid: Cell[] = [
      [1, 1, '0'],
      [2, 1, '=A3+1'],
      [3, 1, '=AND(A1:A2)'],
    ]
    expect(answers(grid, [1, 2, 0])).toEqual(['0', '1', 'FALSE'])
    expect(answers(grid, [2, 1, 0])).toEqual(['0', '1', 'FALSE'])

    const chain: Cell[] = [[1, 1, '1']]
    for (let r = 2; r <= 700; r++) chain.push([r, 1, `=A${r - 1}+1`])
    const asked = [99, 384, 385, 699]
    const seen = [asked, [...asked].reverse(), [384, 99, 699, 385]].map(order => {
      const got = answers(chain, order)
      return asked.map(i => got[i])
    })
    expect(seen).toEqual([0, 1, 2].map(() => ['100', '385', NEEDS_WASM, NEEDS_WASM]))

    // brackets and signs read deep, under a reader that is deep too: the full engine says 1, 1
    const deep: [string, number][] = [
      [`=${'('.repeat(500)}1${')'.repeat(500)}`, 300],
      [`=${'+'.repeat(500)}1`, 300],
      [`=${'('.repeat(600)}1${')'.repeat(600)}`, 400],
    ]
    for (const [inner, terms] of deep) {
      const grid: Cell[] = [
        [1, 3, inner],
        [1, 4, `=C1${'+0'.repeat(terms)}`],
      ]
      expect([answers(grid, [0, 1]), answers(grid, [1, 0])]).toEqual([
        ['1', '1'],
        ['1', '1'],
      ])
    }
  })
})

describe('the core functions', () => {
  test('are these 19', () => {
    expect(FALLBACK_FUNCTIONS).toEqual([
      'SUM',
      'AVERAGE',
      'MIN',
      'MAX',
      'COUNT',
      'COUNTA',
      'IF',
      'AND',
      'OR',
      'NOT',
      'ROUND',
      'ABS',
      'LEN',
      'CONCAT',
      'UPPER',
      'LOWER',
      'IFERROR',
      'SUMIF',
      'VLOOKUP',
    ])
  })

  test('each computes', () => {
    for (const [formula, shown] of [
      ['=SUM(A1:A3)', '6'],
      ['=SUM(A1:C4)', '68.5'],
      ['=AVERAGE(C1:C3)', '20'],
      ['=MIN(C1:C4)', '2.5'],
      ['=MAX(C1:C4, 99)', '99'],
      ['=COUNT(A1:C4)', '7'],
      ['=COUNTA(A1:C4)', '11'],
      ['=IF(A1>0,"yes","no")', 'yes'],
      ['=IF(A1>5,1)', 'FALSE'],
      ['=AND(A1>0, A2>1)', 'TRUE'],
      ['=OR(A1>5, A2>5)', 'FALSE'],
      ['=NOT(A1>0)', 'FALSE'],
      ['=ROUND(2.5,0)', '3'],
      ['=ROUND(-2.5,0)', '-3'],
      ['=ROUND(1234.567,-2)', '1200'],
      ['=ABS(-3)', '3'],
      ['=LEN("héllo")', '5'],
      ['=CONCAT("a",1,TRUE)', 'a1TRUE'],
      ['=CONCAT(A1:B2)', '1apple2pear'],
      ['=UPPER("abc")', 'ABC'],
      ['=LOWER(B3)', 'apple'],
      ['=IFERROR(1/0,"none")', 'none'],
      ['=IFERROR(5,"none")', '5'],
      ['=SUMIF(A1:A3,">1")', '5'],
      ['=SUMIF(B1:B3,"apple",C1:C3)', '40'],
      ['=VLOOKUP(2,A1:C3,3,FALSE)', '20'],
      ['=VLOOKUP("apple",B1:C3,2,0)', '10'],
      ['=sum(A1:A3)', '6'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a range over the whole sheet costs only the cells filled in it', () => {
    const f = sheet([
      [1, 1, '5'],
      [2, 1, '7'],
      [3, 2, 'x'],
      [4, 2, '3'],
      [100, 3, '2'],
    ])
    const started = performance.now()
    for (const [formula, shown] of [
      ['=SUM(A1:Z1048576)', '17'],
      ['=SUM(A1:XFC1048576)', '17'],
      ['=COUNTA(A1:Z1048576)', '5'],
      ['=COUNT(A1:Z1048576)', '4'],
      ['=MIN(A1:Z1048576)', '2'],
      ['=MAX(A1:Z1048576)', '7'],
      ['=AVERAGE(A1:Z1048576)', '4.25'],
      ['=AND(A1:Z1048576)', 'TRUE'],
      ['=OR(A1:Z1048576)', 'TRUE'],
      ['=CONCAT(A1:Z1048576)', '57x32'],
      ['=SUMIF(A1:A1048576,"",B1:B1048576)', '3'],
      ['=SUMIF(A1:A1048576,"<>5",B1:B1048576)', '3'],
      ['=SUMIF(A1:Z1048576,">4")', '12'],
      ['=VLOOKUP(0,A1:B1048576,2,FALSE)', 'x'],
      ['=VLOOKUP(7,A1:B1048576,1,FALSE)', '7'],
      ['=VLOOKUP(FALSE,A1:B1048576,2,FALSE)', 'x'],
      ['=VLOOKUP("x",B1:C1048576,1,FALSE)', 'x'],
      ['=SUM(A1:XFD1048576)', NEEDS_WASM],
    ]) {
      f.set(1, 16384, formula)
      expect({ formula, shown: show(f.value(1, 16384)) }).toEqual({ formula, shown })
    }
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('a call with the wrong number of arguments is an error, never a throw', () => {
    for (const fn of FALLBACK_FUNCTIONS)
      for (let n = 0; n <= 6; n++) {
        const formula = `=${fn}(${Array.from({ length: n }, (_, i) => i + 1).join(',')})`
        expect(typeof at(formula)).toBe('string')
      }
    for (const formula of [
      '=IF()',
      '=IF(1)',
      '=NOT()',
      '=ROUND(1)',
      '=IFERROR(1)',
      '=SUMIF(A1:A3)',
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: '#ERROR!' })
    expect(at('=VLOOKUP(2,A1:C3)')).toBe('#ERROR!')
    expect(at('=MIN()')).toBe('0')
    expect(at('=CONCAT()')).toBe('')
  })
})

describe('what the fallback does not compute', () => {
  test('any other function needs WebAssembly', () => {
    for (const formula of ['=SQRT(4)', '=TODAY()', '=XLOOKUP(1,A1:A3,B1:B3)', '=1+SQRT(4)'])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
    expect(NEEDS_WASM).toBe('#WASM')
  })

  test('an approximate lookup needs WebAssembly', () => {
    expect(at('=VLOOKUP(2,A1:C3,2)')).toBe(NEEDS_WASM)
    expect(at('=VLOOKUP(2,A1:C3,2,TRUE)')).toBe(NEEDS_WASM)
    expect(at('=VLOOKUP(2,A1:C3,2,1)')).toBe(NEEDS_WASM)
  })

  test('a criterion with wildcards needs WebAssembly', () => {
    for (const crit of ['a*', '?pple', '~*', '<>a*'])
      expect(at(`=SUMIF(B1:B3,"${crit}",C1:C3)`)).toBe(NEEDS_WASM)
  })

  test('what it cannot read needs WebAssembly, since the full engine may read it', () => {
    for (const formula of [
      '=SUM(A:A)',
      '=SUM(1:1)',
      '=Other!A1',
      '={1,2}',
      '=1+',
      '=(1',
      '=#',
      '=A1 A2',
      '="abc',
      '=total',
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
  })

  test('a range where one value is expected needs WebAssembly', () => {
    for (const formula of ['=A1:A3', '=A1:A3+1', '=-A1:A3', '=IF(A1:A3,1,2)', '=LEN(A1:A3)'])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
  })

  test('an error caught by IFERROR is caught, but a need for WebAssembly is not hidden', () => {
    expect(at('=IFERROR(1/0,"x")')).toBe('x')
    expect(at('=IFERROR(SQRT(4),"x")')).toBe(NEEDS_WASM)
    expect(at('=IF(TRUE,1,SQRT(4))')).toBe('1')
  })

  test('a cell that needs WebAssembly makes what counts, sums or looks through it need it too', () => {
    const f = sheet(GRID)
    f.set(2, 1, '=SQRT(4)')
    for (const formula of [
      '=A2+1',
      '=SUM(A1:A3)',
      '=COUNT(A1:A3)',
      '=COUNTA(A1:A3)',
      '=CONCAT(A1:A3)',
      '=SUMIF(A1:A3,">0")',
      '=SUMIF(B1:B3,"pear",A1:A3)',
      '=VLOOKUP(3,A1:C3,2,FALSE)',
      '=AND(A1:A3)',
    ]) {
      f.set(9, 9, formula)
      expect({ formula, shown: show(f.value(9, 9)) }).toEqual({ formula, shown: NEEDS_WASM })
    }
    f.set(9, 9, '=OR(A1:A3)')
    expect(show(f.value(9, 9))).toBe('TRUE')
    f.set(9, 9, '=VLOOKUP(1,A1:C3,2,FALSE)')
    expect(show(f.value(9, 9))).toBe(NEEDS_WASM)
  })

  test('a criterion only the full engine can weigh needs WebAssembly', () => {
    for (const formula of [
      '=SUMIF(B1:B3,">a",C1:C3)',
      '=SUMIF(B1:B3,"<=pear",C1:C3)',
      '=SUMIF(A1:A3,">")',
      '=SUMIF(A1:A4,"<TRUE")',
      '=SUMIF(A1:A3,Z9,C1:C3)',
      '=SUMIF(A1:A3,1/0,C1:C3)',
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
  })

  test('a sum over a range of another shape than the tested one needs WebAssembly', () => {
    for (const formula of [
      '=SUMIF(A1:A3,">1",C1:C2)',
      '=SUMIF(A1:A3,">1",C1:D3)',
      '=1/0+SUMIF(A1:A3,">1",C1:C2)',
      '=IF(TRUE,1,SUMIF(A1:A3,">1",C1:C2))',
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
    expect(at('=SUMIF(A1:A3,">1",C2:C4)')).toBe('32.5')
  })

  test('a number whose text the full engine writes its own way needs WebAssembly as text', () => {
    for (const formula of ['=1e21&""', '=LEN(1e-7)', '=UPPER(0*-1)', '=CONCAT(1e30,"x")'])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
    expect(at('=1e20&""')).toBe('100000000000000000000')
    expect(at('=0.000001&""')).toBe('0.000001')
    expect(at('=1e21')).toBe('1E+21')
  })

  test('a power is computed only when it is a number held exactly', () => {
    for (const [formula, shown] of [
      ['=2^10', '1024'],
      ['=2.5^2', '6.25'],
      ['=(-8)^2', '64'],
      ['=2^-1', '0.5'],
      ['=7^1', '7'],
      ['=7.3^0', '1'],
      ['=0^0', '#NUM!'],
      ['=0^-1', '#DIV/0!'],
      ['=2^0.5', NEEDS_WASM],
      ['=10^-2', NEEDS_WASM],
      ['=0.1^2', NEEDS_WASM],
      ['=3^40', NEEDS_WASM],
      ['=(-8)^0.5', NEEDS_WASM],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('ROUND to tens and above is computed where the power of ten is the same in every engine', () => {
    for (const [formula, shown] of [
      ['=ROUND(1234.5678,-2)', '1200'],
      ['=ROUND(1234.5678,-2)&""', '1200'],
      ['=ROUND(1234567,-5)', NEEDS_WASM],
      ['=ROUND(3,-5)', '0'],
      ['=ROUND(12345678901234,-11)', NEEDS_WASM],
      ['=ROUND(7,23)', NEEDS_WASM],
      ['=ROUND(7e22,-23)', NEEDS_WASM],
      ['=ROUND(7,-23)', '0'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a number too large to hold is an error where the cell ends, and needs WebAssembly before', () => {
    for (const [formula, shown] of [
      ['=1e308*10', '#NUM!'],
      ['=-1e308-1e308', '#NUM!'],
      ['=SUM(1e308,1e308)', '#NUM!'],
      ['=AVERAGE(1e308,1e308)', '#NUM!'],
      ['=IFERROR(1e308*10,7)', NEEDS_WASM],
      ['=(1e308*10)&""', NEEDS_WASM],
      ['=1e308*10=1e308*10', NEEDS_WASM],
      ['=MAX(1e308,1e308*10)', NEEDS_WASM],
      ['=1e400', NEEDS_WASM],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a number written with more than 15 digits needs WebAssembly', () => {
    expect(at('=123456789012345')).toBe('1.23457E+14')
    expect(at('=9007199254740993')).toBe(NEEDS_WASM)
    expect(at('=1000000000000000.25&""')).toBe(NEEDS_WASM)
    expect(at('=0.1234567890123456')).toBe(NEEDS_WASM)
    expect(at('=1000000000000000000')).toBe('1E+18')
  })

  test('a number as text with two nearest spellings needs WebAssembly', () => {
    expect(at('=(600000000000000+3/8)&""')).toBe('600000000000000.4')
    expect(at('=(600000000000000+1/4)&""')).toBe(NEEDS_WASM)
    expect(at('=CONCAT(8388608+1/1024)')).toBe(NEEDS_WASM)
    expect(at('=CONCAT(8388608+3/1024)')).toBe(NEEDS_WASM)
    expect(at('=CONCAT(8388608+1/512)')).toBe('8388608.001953125')
  })

  test('a reference past the last row or column needs WebAssembly', () => {
    expect(at('=XFD1048576')).toBe('0')
    for (const formula of ['=XFE1', '=ZZZ1', '=A1048577', '=A0', '=SUM(A0:A2)', '=IFERROR(ZZZ1,5)'])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown: NEEDS_WASM })
  })

  test('ROUND reads a number at 15 digits, as the full engine does', () => {
    for (const [formula, shown] of [
      ['=ROUND(7,20)', '7'],
      ['=ROUND(7.25,1000)', '7.25'],
      ['=ROUND(7.25,-1000)', '0'],
      ['=ROUND(0,20)', '0'],
      ['=ROUND(0.4999999999,0)', '0'],
      ['=ROUND(4.9999999999,-1)', '0'],
      ['=ROUND(2.5,0)', '3'],
      ['=ROUND(-2.5,0)', '-3'],
      ['=ROUND(1.005,2)&""', '1.01'],
      ['=ROUND(0.1+0.2,400)&""', '0.3'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('text that only the full engine reads as a number needs WebAssembly in sums', () => {
    for (const text of ['1,000', '$5', '50%', '2026-01-02', '1/2', '(5)'])
      expect({ text, shown: at(`="${text}"+1`) }).toEqual({ text, shown: NEEDS_WASM })
    expect(at('="w1"+1')).toBe('#VALUE!')
    expect(at('=""+1')).toBe('#VALUE!')
    expect(at('="1e2"+1')).toBe('101')
    expect(at('=" 5 "+1')).toBe('6')
  })
})

describe('how values are read', () => {
  test('AND and OR stop at the first value that decides them', () => {
    const f = sheet(GRID)
    f.set(1, 4, '=1/0')
    f.set(2, 4, '=SQRT(4)')
    for (const [formula, shown] of [
      ['=OR(TRUE,D1)', 'TRUE'],
      ['=OR(D1,TRUE)', '#DIV/0!'],
      ['=OR(FALSE,D1)', '#DIV/0!'],
      ['=OR(A1:D1)', 'TRUE'],
      ['=AND(FALSE,D1)', 'FALSE'],
      ['=AND(TRUE,D1)', '#DIV/0!'],
      ['=OR(TRUE,D2)', 'TRUE'],
      ['=OR(FALSE,D2)', NEEDS_WASM],
      ['=OR("true")', 'TRUE'],
      ['=AND("TRUE","x")', 'TRUE'],
      ['=OR("x")', '#VALUE!'],
      ['=OR(B1:B3)', '#VALUE!'],
      ['=OR(B1:B3,0)', 'FALSE'],
    ]) {
      f.set(9, 9, formula)
      expect({ formula, shown: show(f.value(9, 9)) }).toEqual({ formula, shown })
    }
  })

  test('a condition is yes or no, a number, or the words TRUE and FALSE', () => {
    for (const [formula, shown] of [
      ['=IF("x",1,2)', '#VALUE!'],
      ['=IF("12",1,2)', '#VALUE!'],
      ['=IF("true",1,2)', '1'],
      ['=IF(B1,1,2)', '#VALUE!'],
      ['=IF(Z9,1,2)', '2'],
      ['=IF(-1,1,2)', '1'],
      ['=NOT("x")', '#VALUE!'],
      ['=NOT("FALSE")', 'TRUE'],
      ['=NOT(Z9)', 'TRUE'],
      ['=NOT(B1)', '#VALUE!'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a plus sign in front changes nothing', () => {
    for (const [formula, shown] of [
      ['=+TRUE', 'TRUE'],
      ['=+"x"', 'x'],
      ['=+B1', 'apple'],
      ['=+Z9', '0'],
      ['=SUM(+A4,1)', '1'],
      ['=SUM(-A4,1)', '0'],
      ['=1+-+-1', '2'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a value typed into a count counts as written, a cell only as a number', () => {
    for (const [formula, shown] of [
      ['=COUNT(1,"2",TRUE,"x")', '3'],
      ['=COUNT(A1:A4,B1)', '3'],
      ['=COUNT(1/0)', '0'],
      ['=COUNT("$5")', NEEDS_WASM],
      ['=COUNTA(A1:A3,"")', '4'],
      ['=COUNTA(A1:A3,Z9)', '3'],
      ['=COUNTA(1/0)', '1'],
      ['=AVERAGE(IF(TRUE,Z9))', '#DIV/0!'],
      ['=AVERAGE(IF(TRUE,Z9),4)', '4'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('the error on the left comes first', () => {
    for (const [formula, shown] of [
      ['="x"+1/0', '#VALUE!'],
      ['=1/0+"x"', '#DIV/0!'],
      ['="x"&1/0', '#DIV/0!'],
      ['="x"^VLOOKUP(9,A1:C3,2,FALSE)', '#VALUE!'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('SUMIF tests each cell and sums the one beside it', () => {
    const f = sheet(GRID)
    f.set(1, 4, '=1/0')
    f.set(2, 4, '5')
    for (const [formula, shown] of [
      ['=SUMIF(A1,1)', '#VALUE!'],
      ['=SUMIF(A1:A3,">1",5)', '#VALUE!'],
      ['=SUMIF(A1:A3,">0",D1:D3)', '#DIV/0!'],
      ['=SUMIF(A1:A3,">1",D1:D3)', '5'],
      ['=SUMIF(A1:B4,"<>")', '6'],
      ['=SUMIF(D1:D4,"<>")', '#DIV/0!'],
      ['=SUMIF(A1:A4,"TRUE",C1:C4)', '2.5'],
      ['=SUMIF(A1:A4,"<>true",C1:C4)', '60'],
      ['=SUMIF(A1:A4,TRUE,C1:C4)', '2.5'],
      ['=SUMIF(B1:B4,FALSE,C1:C4)', '0'],
      ['=SUMIF(B1:B4,"",C1:C4)', '2.5'],
    ]) {
      f.set(9, 9, formula)
      expect({ formula, shown: show(f.value(9, 9)) }).toEqual({ formula, shown })
    }
  })

  test('VLOOKUP passes on the errors of what it is given', () => {
    for (const [formula, shown] of [
      ['=VLOOKUP(1/0,A1:C3,4,FALSE)', '#DIV/0!'],
      ['=VLOOKUP(2,A1:C3,1/0,FALSE)', '#DIV/0!'],
      ['=VLOOKUP(2,A1:C3,"x",FALSE)', '#VALUE!'],
      ['=VLOOKUP("",B1:C5,2,FALSE)', '#N/A'],
      ['=VLOOKUP(2,A1,1,FALSE)', NEEDS_WASM],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })
})

describe('cells', () => {
  test('hold numbers, text and yes or no as typed', () => {
    const f = new FallbackSheet()
    for (const [input, value] of [
      ['42', 42],
      [' 42 ', 42],
      ['-2.5', -2.5],
      ['hello', 'hello'],
      ['true', true],
      ['FALSE', false],
      ['0x10', '0x10'],
      ['Infinity', 'Infinity'],
      ['-', '-'],
      ['3 apples', '3 apples'],
      ['12:00', '12:00'],
      ['www.example.com', 'www.example.com'],
      ["'42", '42'],
      ["'=1+1", '=1+1'],
      ['=', '='],
    ] as const) {
      f.set(1, 1, input)
      expect(f.value(1, 1)).toBe(value)
    }
  })

  test('a typed error is that error', () => {
    const f = new FallbackSheet()
    for (const [input, err] of [
      ['#N/A', '#N/A'],
      ['#div/0!', '#DIV/0!'],
      ['#REF!', '#REF!'],
    ]) {
      f.set(1, 1, input)
      f.set(1, 2, '=A1+1')
      f.set(1, 3, '=IFERROR(A1,"caught")')
      expect([show(f.value(1, 1)), show(f.value(1, 2)), show(f.value(1, 3))]).toEqual([
        err,
        err,
        'caught',
      ])
    }
    f.set(1, 1, '#hashtag')
    expect(f.value(1, 1)).toBe('#hashtag')
  })

  test('what the full engine would read as an amount, a share, a date or a formula needs WebAssembly', () => {
    const f = new FallbackSheet()
    for (const input of [
      '1,000',
      '$5',
      '-$5',
      '5 €',
      '50%',
      '1.5 %',
      '1/2/2023',
      '2023-01-02',
      'January-5-2023',
      '1e3',
      ' 2.5E+3 ',
      '+1+1',
      '-A1',
      "'",
    ]) {
      f.set(1, 1, input)
      expect({ input, value: f.value(1, 1) }).toEqual({ input, value: { err: NEEDS_WASM } })
    }
  })

  test('a blank cell is nothing, shows empty, and counts as 0, "" and FALSE', () => {
    const f = new FallbackSheet()
    expect(f.value(5, 5)).toBe(null)
    expect(show(f.value(5, 5))).toBe('')
    for (const [formula, shown] of [
      ['=Z99', '0'],
      ['=Z99+1', '1'],
      ['=Z99&"x"', 'x'],
      ['=Z99=0', 'TRUE'],
      ['=Z99=""', 'TRUE'],
      ['=Z99=FALSE', 'TRUE'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('a change to a cell reaches the cells that read it', () => {
    const f = new FallbackSheet()
    f.set(1, 1, '1')
    f.set(2, 1, '=A1+1')
    f.set(3, 1, '=A2*10')
    expect(f.value(3, 1)).toBe(20)
    f.set(1, 1, '10')
    expect(f.value(3, 1)).toBe(110)
    f.set(1, 1, '')
    expect(f.inputs.has('1,1')).toBe(false)
    expect(f.value(3, 1)).toBe(10)
  })

  test('cells that read each other in a circle need WebAssembly', () => {
    const f = new FallbackSheet()
    f.set(1, 1, '=A2')
    f.set(2, 1, '=A1')
    f.set(3, 1, '=A3')
    f.set(4, 1, '=IFERROR(A1,7)')
    expect(show(f.value(1, 1))).toBe(NEEDS_WASM)
    expect(show(f.value(2, 1))).toBe(NEEDS_WASM)
    expect(show(f.value(3, 1))).toBe(NEEDS_WASM)
    expect(show(f.value(4, 1))).toBe(NEEDS_WASM)
  })

  test('a chain of cells too long to follow needs WebAssembly, and nothing throws', () => {
    const f = new FallbackSheet()
    f.set(1, 1, '1')
    for (let r = 2; r <= 100_000; r++) f.set(r, 1, `=A${r - 1}+1`)
    expect(show(f.value(100_000, 1))).toBe(NEEDS_WASM)
    expect(f.value(200, 1)).toBe(200)
  }, 60_000)

  test('a formula nested too deeply to read needs WebAssembly, and nothing throws', () => {
    const f = new FallbackSheet()
    f.set(1, 1, `=${'('.repeat(200_000)}1${')'.repeat(200_000)}`)
    f.set(2, 1, `=1${'+1'.repeat(200_000)}`)
    expect([NEEDS_WASM, '1']).toContain(show(f.value(1, 1)))
    expect([NEEDS_WASM, '200001']).toContain(show(f.value(2, 1)))
  }, 60_000)

  test('errors travel through what reads them', () => {
    for (const [formula, shown] of [
      ['=1/0', '#DIV/0!'],
      ['=1/0+1', '#DIV/0!'],
      ['="a"+1', '#VALUE!'],
      ['=-"x"', '#VALUE!'],
      ['=SUM(1/0,2)', '#DIV/0!'],
      ['=CONCAT("a",1/0)', '#DIV/0!'],
      ['=AVERAGE(B1:B2)', '#DIV/0!'],
      ['=VLOOKUP(9,A1:C3,2,FALSE)', '#N/A'],
      ['=VLOOKUP(2,A1:C3,4,FALSE)', '#REF!'],
      ['=1e308*10', '#NUM!'],
      ['=0^0', '#NUM!'],
      ['=0^-1', '#DIV/0!'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })
})

describe('the formula language', () => {
  test('operators bind as in a spreadsheet', () => {
    for (const [formula, shown] of [
      ['=1+2*3', '7'],
      ['=(1+2)*3', '9'],
      ['=2^3^2', '64'],
      ['=2^(3^2)', '512'],
      ['=-2^2', '4'],
      ['=2*3^2', '18'],
      ['=1-2-3', '-4'],
      ['=8/4/2', '1'],
      ['=50%', '0.5'],
      ['=10%*200', '20'],
      ['="a"&"b"&1', 'ab1'],
      ['=1+2&3', '33'],
      ['=--3', '3'],
      ['=1.5e3', '1500'],
      ['=.5', '0.5'],
      ['="say ""hi"""', 'say "hi"'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('comparisons order numbers before text before yes or no, and ignore case', () => {
    for (const [formula, shown] of [
      ['=1=1', 'TRUE'],
      ['=1<>1', 'FALSE'],
      ['="a"="A"', 'TRUE'],
      ['="a"<"b"', 'TRUE'],
      ['=1<"a"', 'TRUE'],
      ['="a"<TRUE', 'TRUE'],
      ['=2>=2', 'TRUE'],
      ['=1<=0', 'FALSE'],
      ['=0.1+0.2=0.3', 'TRUE'],
      ['=0.1+0.2>0.3', 'FALSE'],
      ['=1e-16=0', 'TRUE'],
      ['=1e15+1=1e15+2', 'TRUE'],
      ['=123456789012345=123456789012346', 'FALSE'],
      ['="a"<"_"', 'TRUE'],
      ['="ß"="SS"', 'TRUE'],
      ['="Z"<"ä"', 'TRUE'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('references may be absolute and in either case', () => {
    for (const [formula, shown] of [
      ['=$A$1+A$2+$A3', '6'],
      ['=a1+1', '2'],
      ['=sum(a1:a3)', '6'],
      ['=SUM($A$1:$A$3)', '6'],
      ['=SUM($a$1:$c$3)', '66'],
      ['=$c$3', '30'],
    ])
      expect({ formula, shown: at(formula) }).toEqual({ formula, shown })
  })

  test('an address is a row and a column', () => {
    expect(addr('B3')).toEqual([3, 2])
    expect(addr('$AA$10')).toEqual([10, 27])
    expect(addr('XFD1048576')).toEqual([1048576, 16384])
    for (const bad of ['AAAA1', 'A12345678', '1A', 'A', '', 'XFE1', 'ZZZ1', 'A1048577', 'A0'])
      expect(() => addr(bad)).toThrow()
  })
})

describe('how a value is shown', () => {
  test('numbers show with up to nine decimals, then in powers of ten', () => {
    for (const [n, shown] of [
      [0, '0'],
      [-0, '0'],
      [1, '1'],
      [-1.5, '-1.5'],
      [1 / 3, '0.333333333'],
      [2 / 3, '0.666666667'],
      [1 / 1024, '0.000976562'],
      [3 / 1024, '0.002929688'],
      [99999999999, '99999999999'],
      [12345678901.5, '12345678901.5'],
      [1e-8, '0.00000001'],
      [1e-9, '1E-09'],
      [9.999995e22, '10E+22'],
      [0.1 + 0.2, '0.3'],
      [1e10, '10000000000'],
      [1e11, '1E+11'],
      [123456789012, '1.23457E+11'],
      [1e-10, '1E-10'],
      [1.5e-12, '1.5E-12'],
      [-1e21, '-1E+21'],
      [123456.7890123, '123456.7890123'],
      [1234567890.1234567, '1234567890.123456717'],
    ] as const)
      expect({ n, shown: formatGeneral(n) }).toEqual({ n, shown })
  })

  test('other values show as a sheet shows them', () => {
    expect(show(null)).toBe('')
    expect(show(true)).toBe('TRUE')
    expect(show(false)).toBe('FALSE')
    expect(show('x')).toBe('x')
    expect(show({ err: '#N/A' })).toBe('#N/A')
    expect(show(1e11)).toBe('1E+11')
  })
})
