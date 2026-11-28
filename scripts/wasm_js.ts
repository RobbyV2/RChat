// Converts the client's WebAssembly modules into JavaScript, for pages that cannot run
// WebAssembly: apps/web/public/wasm/<module>_js.js, with the same exports and no init step.
// Runs after wasm-pack (`bun run build:wasm`). The modules to convert are the arguments, or
// the builds in the cargo target directory: the release ones, or the dev ones with `--dev`.
import { $ } from 'bun'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
// The shared rules, loaded when the app starts, and the picture codec, loaded when a device
// makes a picture.
export const MODULES = ['rust_next_wasm', 'rchat_picture_wasm'] as const

const builtModules = async (profile: string) => {
  const meta = (await $`cargo metadata --format-version 1 --no-deps`.cwd(root).json()) as {
    target_directory: string
  }
  return MODULES.map(name =>
    join(meta.target_directory, 'wasm32-unknown-unknown', profile, `${name}.wasm`)
  )
}

const bin = (tool: string) => join(root, 'node_modules', '.bin', tool)

const convert = async (source: string) => {
  const name = basename(source, '.wasm')
  const work = mkdtempSync(join(tmpdir(), 'wasm-js-'))
  try {
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
    await $`wasm-bindgen --target bundler --out-dir ${work} --out-name ${name} ${lowered}`.quiet()
    const converted = `${name}_bg.wasm.js`
    await $`${bin('wasm2js')} -O ${join(work, `${name}_bg.wasm`)} -o ${join(work, converted)}`.quiet()
    const entry = join(work, `${name}.js`)
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8').replaceAll(`./${name}_bg.wasm"`, `./${converted}"`)
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
    const file = join(root, 'apps', 'web', 'public', 'wasm', `${name}_js.js`)
    await Bun.write(file, bundled)
    console.log(`wrote ${file}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dev = args.includes('--dev')
  const given = args.filter(arg => arg !== '--dev')
  const sources = given.length > 0 ? given : await builtModules(dev ? 'debug' : 'release')
  for (const source of sources) await convert(source)
}
