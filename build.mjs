#!/usr/bin/env node
/**
 * Bundle the markdown-adapter plugin into a standalone third-party plugin.
 *
 * Output directory (dist/) contains:
 *   - index.js        (self-contained ESM bundle)
 *   - index.js.map    (source map)
 *
 * The root directory already contains myndra-plugin.json, assets/, and the .wasm file.
 *
 * Usage:  node build.mjs [--watch]
 */

import { build, context } from 'esbuild'
import { myndraHostModules } from '@myndra/plugin-sdk/build'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'dist')
const watchMode = process.argv.includes('--watch')

mkdirSync(outDir, { recursive: true })

const options = {
  entryPoints: [join(__dirname, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(outDir, 'index.js'),
  treeShaking: true,
  sourcemap: true,
  plugins: [myndraHostModules()],
}

if (watchMode) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('Watching markdown-adapter for changes...')
} else {
  console.log('Building markdown-adapter...')
  await build(options)
  console.log('Done. Output in dist/')
}
