/**
 * Publish @yolo-labs/yolo-cli via npm's own `libnpmpublish` library.
 *
 * Why not plain `npm publish`: the npm CLI's publish path 403s ("forbidden by
 * your security policy") with our org token — its otplease/2FA wrapper issues
 * the request in a way the registry rejects (confirmed for @yolo-labs/flexdb +
 * @yolo-labs/yolomax). Calling `libnpmpublish.publish()` directly with
 * `forceAuth: { token }` sends a clean Bearer and succeeds. Mirrors
 * yolomax/scripts/npm-publish.cjs.
 *
 * Inputs:
 *   - NODE_AUTH_TOKEN (or NPM_TOKEN) in env — must have write access to the
 *     @yolo-labs scope (the same scope that publishes flexdb + yolomax).
 *   - A packed tarball in cwd — the workflow runs `npm run build` then `npm pack`
 *     first. Published with public access.
 *
 * A 409 is not automatically a failure: a version bump wakes the workflow twice
 * (push + `yolo-cli tests` workflow_run), and the second run's "already
 * published?" check can miss the first run's publish because npm's packument
 * lags by a minute or two. On 409 we wait for the version to become visible and
 * succeed only if it holds byte-identical contents to our tarball (both runs
 * build the same commit, and `npm pack` is reproducible).
 */
const { execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

/** Load npm's bundled libnpmpublish (always ships with the npm CLI) — no devDep. */
function loadPublish() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'npm', 'node_modules', 'libnpmpublish')).publish;
  } catch (e1) {
    try {
      return require('libnpmpublish').publish; // fallback if it's installed normally
    } catch (e2) {
      throw new Error(`Could not load libnpmpublish: ${e1.message} / ${e2.message}`);
    }
  }
}

/** dist.integrity npm reports for `spec`, or null while the registry doesn't show it. */
function registryIntegrity(spec) {
  try {
    const out = execSync(`npm view ${spec} dist.integrity --prefer-online`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** After a 409: 'identical' | 'different' | 'missing' (still invisible after ~3 min). */
async function compareWithRegistry(spec, tarball) {
  const ours = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const theirs = registryIntegrity(spec);
    if (theirs) return theirs === ours ? 'identical' : 'different';
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return 'missing';
}

(async () => {
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!token) {
    console.error('No NODE_AUTH_TOKEN / NPM_TOKEN in env.');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  // npm pack flattens the scoped name: @yolo-labs/yolo-cli → yolo-labs-yolo-cli
  const tgz = `${manifest.name.replace(/^@/, '').replace(/\//g, '-')}-${manifest.version}.tgz`;
  if (!existsSync(tgz)) {
    console.error(`Tarball ${tgz} not found — run \`npm pack\` first.`);
    process.exit(1);
  }
  const publish = loadPublish();
  const spec = `${manifest.name}@${manifest.version}`;
  const tarball = readFileSync(tgz);
  try {
    await publish(manifest, tarball, {
      registry: 'https://registry.npmjs.org/',
      access: (manifest.publishConfig && manifest.publishConfig.access) || 'public',
      defaultTag: 'latest',
      forceAuth: { token },
    });
    console.log(`Published ${manifest.name}@${manifest.version} (public).`);
  } catch (e) {
    if (e.statusCode === 409) {
      const match = await compareWithRegistry(spec, tarball);
      if (match === 'identical') {
        console.log(`${spec} is already on npm with this exact tarball (published by a concurrent run). Nothing to do.`);
        return;
      }
      console.error(
        match === 'different'
          ? `${spec} is already on npm with DIFFERENT contents than this build.`
          : `${spec}: the registry returned 409 but the version never became visible.`,
      );
    }
    console.error(`Publish failed: code=${e.code} status=${e.statusCode}`);
    console.error('body:', typeof e.body === 'object' ? JSON.stringify(e.body) : String(e.body || '').slice(0, 500));
    process.exit(1);
  }
})();
