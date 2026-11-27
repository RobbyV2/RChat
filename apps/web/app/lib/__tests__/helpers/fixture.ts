// What a test sets up that outlives it (a session, a node, changed module state) is undone where it
// is made: `own(value, undo)`. Made in a test or its beforeEach, it is undone after that test; made
// outside any test (at file load, in a describe body or a beforeAll), after the file's last test.
// `fixture_preload.ts` runs both scopes, the newest first, for every test file.

type Undo = () => unknown

const scopes = { test: [] as Undo[], file: [] as Undo[] }
let inTest = false

export function own<T>(value: T, undo: (value: T) => unknown): T {
  scopes[inTest ? 'test' : 'file'].push(() => undo(value))
  return value
}

const undoAll = async (undos: Undo[]) => {
  const failures: unknown[] = []
  for (const undo of undos.splice(0).reverse()) {
    try {
      await undo()
    } catch (e) {
      failures.push(e)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'fixtures failed to undo')
}

// What the preload runs around each test and each file.
export const fixtureScopes = {
  testStarts() {
    inTest = true
  },
  testEnds() {
    inTest = false
    return undoAll(scopes.test)
  },
  fileEnds() {
    return undoAll(scopes.file)
  },
}
