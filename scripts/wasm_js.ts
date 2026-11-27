// Converts the client's WebAssembly module into JavaScript, for pages that cannot run
// WebAssembly: apps/web/public/wasm/rust_next_wasm_js.js, with the same exports and no init step.
// Runs after wasm-pack (`bun run build:wasm`). The module to convert is the first argument, or
// the build in the cargo target directory: the release one, or the dev one with `--dev`.
import { $ } from 'bun'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const NAME = 'rust_next_wasm'

const builtModule = async (profile: string) => {
  const meta = (await $`cargo metadata --format-version 1 --no-deps`.cwd(root).json()) as {
    target_directory: string
  }
  return join(meta.target_directory, 'wasm32-unknown-unknown', profile, `${NAME}.wasm`)
}

const arg = process.argv[2]
const source =
  arg === undefined || arg === '--dev'
    ? await builtModule(arg === undefined ? 'release' : 'debug')
    : arg
const work = mkdtempSync(join(tmpdir(), 'wasm-js-'))
try {
  const bin = (tool: string) => join(root, 'node_modules', '.bin', tool)
  // The converter takes one table and the first wasm feature set: lower what Rust emits beyond
  // it, and drop the feature list so wasm-bindgen adds no second table.
  const lowered = join(work, 'lowered.wasm')
  const lowering = [
    '--llvm-nontrapping-fptoint-lowering',
    '--llvm-memory-copy-fill-lowering',
    '--signext-lowering',
    '--strip-target-features',
  ]
  await $`${bin('wasm-opt')} ${lowering} ${source} -o ${lowered}`.quiet()
  await $`wasm-bindgen --target bundler --out-dir ${work} --out-name ${NAME} ${lowered}`.quiet()
  const converted = `${NAME}_bg.wasm.js`
  await $`${bin('wasm2js')} -O ${join(work, `${NAME}_bg.wasm`)} -o ${join(work, converted)}`.quiet()
  const entry = join(work, `${NAME}.js`)
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8').replaceAll(`./${NAME}_bg.wasm"`, `./${converted}"`)
  )
  const out = await Bun.build({ entrypoints: [entry], format: 'esm', target: 'browser' })
  if (!out.success) throw new AggregateError(out.logs, 'bundling the converted module failed')
  // Converted memory grows into a new buffer and leaves the old one attached, so the glue's
  // cached views are renewed whenever the buffer is another one.
  const stale = (view: string) => `${view}.buffer !== wasm.memory.buffer`
  const bundled = (await out.outputs[0].text())
    .replace(/(cached\w+Memory0)\.byteLength === 0/g, (_, view: string) => stale(view))
    .replace(
      /(cachedDataViewMemory0)\.buffer\.detached === true \|\|[^{]*\) \{/g,
      (_, view: string) => `${stale(view)}) {`
    )
  if (
    !bundled.includes(stale('cachedUint8ArrayMemory0')) ||
    /\.detached|byteLength === 0/.test(bundled)
  )
    throw new Error('the glue caches memory views in a form this script does not know')
  const file = join(root, 'apps', 'web', 'public', 'wasm', `${NAME}_js.js`)
  await Bun.write(file, bundled)
  console.log(`wrote ${file}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
