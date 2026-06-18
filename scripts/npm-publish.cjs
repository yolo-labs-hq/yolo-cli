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
 */
const { execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
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
  try {
    await publish(manifest, readFileSync(tgz), {
      registry: 'https://registry.npmjs.org/',
      access: (manifest.publishConfig && manifest.publishConfig.access) || 'public',
      defaultTag: 'latest',
      forceAuth: { token },
    });
    console.log(`Published ${manifest.name}@${manifest.version} (public).`);
  } catch (e) {
    console.error(`Publish failed: code=${e.code} status=${e.statusCode}`);
    console.error('body:', typeof e.body === 'object' ? JSON.stringify(e.body) : String(e.body || '').slice(0, 500));
    process.exit(1);
  }
})();
