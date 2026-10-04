/**
 * Vendor @yolo-labs/flexdb into the CLI so `yolo deploy` can bundle it into a
 * customer Worker WITHOUT the package being installable from a registry.
 *
 * The deploy bundler resolves `import { FlexDB } from '@yolo-labs/flexdb'` to
 * this vendored copy via an esbuild plugin (see deploy-bundle.ts) when the
 * customer project has no installed copy. This script produces that copy: a
 * single self-contained ESM module (FlexDB is zero-dep) emitted into
 * `dist/vendored/flexdb.mjs`, which ships in the CLI tarball (`files: ["dist"]`).
 *
 * Inside the monorepo it bundles the sibling `packages/flexdb` source so the CLI
 * always ships current FlexDB. In the standalone public mirror of this package
 * (github.com/yolo-labs-hq/yolo-cli) that sibling doesn't exist, so it falls
 * back to the published `@yolo-labs/flexdb` devDependency.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoEntry = resolve(here, '../../flexdb/src/index.ts');
const flexdbEntry = existsSync(monorepoEntry)
  ? monorepoEntry
  : fileURLToPath(import.meta.resolve('@yolo-labs/flexdb'));
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
