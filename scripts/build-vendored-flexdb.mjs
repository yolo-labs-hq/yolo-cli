/**
 * Vendor @yololabs/flexdb into the CLI so `yolo deploy` can bundle it into a
 * customer Worker WITHOUT the package being installable from a registry.
 *
 * FlexDB isn't published yet (it will be soon). Until then, the deploy bundler
 * resolves `import { FlexDB } from '@yololabs/flexdb'` to this vendored copy via
 * an esbuild plugin (see deploy-bundle.ts). This script produces that copy: a
 * single self-contained ESM module (FlexDB is zero-dep) emitted into
 * `dist/vendored/flexdb.mjs`, which ships in the CLI tarball (`files: ["dist"]`).
 *
 * Once @yololabs/flexdb is published, this vendoring can be dropped (the deploy
 * bundler already prefers a real installed copy — vendored is the fallback).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const flexdbEntry = resolve(here, '../../flexdb/src/index.ts');
const outDir = resolve(here, '../dist/vendored');
const outfile = resolve(outDir, 'flexdb.mjs');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [flexdbEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker'],
  target: 'es2022',
  outfile,
  // Keep it readable-ish; the bundle is tiny and the customer's own build minifies.
  minify: false,
});

console.log(`[build-vendored-flexdb] wrote ${outfile}`);
