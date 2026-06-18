/**
 * skopeo OCI assembler — Dockerfile parsing + container-engine-free assembly.
 *   - parseDockerfile classifies assemblable vs not (RUN / multi-stage / glob / ADD-url).
 *   - buildCopyLayer stages COPY files into a deterministic tar (+ rejects escapes).
 *   - applyDockerfileToConfig patches Cmd/WorkingDir/ExposedPorts/Env.
 *   - assembleOciArchive appends a layer + patches config and produces a
 *     DIGEST-CONSISTENT OCI layout (verified by a mock skopeo export).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseDockerfile, buildCopyLayer, applyDockerfileToConfig, assembleOciArchive,
} from './tileapp-oci-assembler.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asm-test-'));
const sha = (b: Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');

// Minimal tar reader for assertions (name/mode/type per entry).
function tarEntries(tar: Buffer): { name: string; mode: number; type: string }[] {
  const out: { name: string; mode: number; type: string }[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const oct = (s: number, e: number) => parseInt(block.subarray(s, e).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, '');
    const size = oct(124, 136);
    out.push({ name: full, mode: oct(100, 108), type: String.fromCharCode(block[156]) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
const tarNames = (tar: Buffer) => tarEntries(tar).filter((e) => e.type === '0').map((e) => e.name);
const tarMode = (tar: Buffer, name: string) => tarEntries(tar).find((e) => e.name === name)?.mode ?? -1;

describe('parseDockerfile', () => {
  test('assemblable: FROM + COPY + CMD + EXPOSE + ENV + WORKDIR', () => {
    const p = parseDockerfile([
      'FROM node:20-slim', 'WORKDIR /app', 'COPY . /app', 'COPY server.js /app/',
      'ENV NODE_ENV=production', 'EXPOSE 8080', 'CMD ["node","server.js"]',
    ].join('\n'));
    assert.equal(p.assemblable, true);
    assert.equal(p.from, 'node:20-slim');
    assert.equal(p.workdir, '/app');
    assert.deepEqual(p.cmd, ['node', 'server.js']);
    assert.deepEqual(p.exposes, ['8080/tcp']);
    assert.deepEqual(p.env, [{ k: 'NODE_ENV', v: 'production' }]);
    assert.equal(p.copies.length, 2);
  });

  test('shell-form CMD wraps in /bin/sh -c', () => {
    const p = parseDockerfile('FROM alpine\nCOPY x /\nCMD python server.py');
    assert.deepEqual(p.cmd, ['/bin/sh', '-c', 'python server.py']);
  });

  test('continuation lines + comments', () => {
    const p = parseDockerfile('# a comment\nFROM alpine\nCOPY \\\n  a.txt /\n');
    assert.equal(p.assemblable, true);
    assert.deepEqual(p.copies, [{ src: 'a.txt', dest: '/', destIsDir: true, mode: undefined }]);
  });

  test('resolves relative COPY dest against WORKDIR', () => {
    const p = parseDockerfile('FROM node\nWORKDIR /app\nCOPY . .\nCOPY x.js sub/\nCOPY y.js /opt/');
    assert.equal(p.copies[0].dest, '/app'); assert.equal(p.copies[0].destIsDir, true);
    assert.equal(p.copies[1].dest, '/app/sub'); assert.equal(p.copies[1].destIsDir, true);
    assert.equal(p.copies[2].dest, '/opt'); // absolute dest unaffected by WORKDIR
  });

  test('NOT assemblable: RUN', () => {
    const p = parseDockerfile('FROM alpine\nRUN apk add curl\nCOPY x /');
    assert.equal(p.assemblable, false);
    assert.match(p.unsupported.join(' '), /RUN/);
  });

  test('NOT assemblable: multi-stage (FROM AS / COPY --from)', () => {
    assert.equal(parseDockerfile('FROM node AS build\nFROM nginx\nCOPY x /').assemblable, false);
    const p = parseDockerfile('FROM nginx\nCOPY --from=build /a /b');
    assert.equal(p.assemblable, false);
    assert.match(p.unsupported.join(' '), /--from/);
  });

  test('NOT assemblable: ADD <url>, glob source, no FROM', () => {
    assert.match(parseDockerfile('FROM x\nADD http://e/f /').unsupported.join(' '), /url/);
    assert.match(parseDockerfile('FROM x\nCOPY *.js /app').unsupported.join(' '), /glob/);
    assert.match(parseDockerfile('COPY a /').unsupported.join(' '), /no FROM/);
  });

  test('NOT assemblable: ADD archive, ARG-substituted FROM/COPY, COPY --chown', () => {
    assert.match(parseDockerfile('FROM x\nADD app.tar /app/').unsupported.join(' '), /archive/);
    assert.match(parseDockerfile('ARG B=alpine\nFROM ${B}\nCOPY a /').unsupported.join(' '), /ARG|variable/);
    assert.match(parseDockerfile('FROM x\nCOPY ${SRC} /a').unsupported.join(' '), /ARG|variable/);
    assert.match(parseDockerfile('FROM x\nCOPY --chown=node:node a /a').unsupported.join(' '), /unsupported flag/);
  });

  test('NOT assemblable: variable WORKDIR, FROM --platform', () => {
    assert.match(parseDockerfile('FROM x\nWORKDIR $APP_HOME\nCOPY . .').unsupported.join(' '), /WORKDIR.*variable/);
    assert.match(parseDockerfile('FROM --platform=linux/arm64 alpine\nCOPY a /').unsupported.join(' '), /platform/);
  });

  test('preserves EXPOSE protocol (udp not coerced to tcp); SHELL falls back', () => {
    const p = parseDockerfile('FROM x\nCOPY a /\nEXPOSE 8125/udp\nEXPOSE 80');
    assert.deepEqual(p.exposes, ['8125/udp', '80/tcp']);
    assert.match(parseDockerfile('FROM x\nCOPY a /\nSHELL ["/bin/bash","-lc"]').unsupported.join(' '), /SHELL/);
    assert.match(parseDockerfile('FROM x\nENV H=/app\nCOPY . $H').unsupported.join(' '), /variable destination/);
  });

  test('parses a quoted ENV value with spaces (single assignment)', () => {
    const p = parseDockerfile('FROM x\nCOPY a /\nENV NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"');
    assert.equal(p.assemblable, true);
    assert.deepEqual(p.env, [{ k: 'NODE_OPTIONS', v: '--max-old-space-size=512 --enable-source-maps' }]);
  });

  test('COPY into a declared WORKDIR is treated as a directory target', () => {
    // `WORKDIR /app` makes /app a dir, so `COPY server.js /app` → /app/server.js.
    const p = parseDockerfile('FROM node\nWORKDIR /app\nCOPY server.js /app');
    assert.equal(p.copies[0].dest, '/app');
    assert.equal(p.copies[0].destIsDir, true);
  });
});

describe('buildCopyLayer', () => {
  test('stages a file + a dir, rejects context escape + missing src', () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(ctx, 'app'));
    fs.writeFileSync(path.join(ctx, 'app', 'index.html'), '<h1>');
    const r = buildCopyLayer(ctx, [{ src: 'hello.txt', dest: '/' }, { src: 'app', dest: '/srv/app' }]);
    assert.equal(r.ok, true);
    if (r.ok) {
      // valid tar: length is a multiple of 512, ends with zero blocks
      assert.equal(r.tar.length % 512, 0);
      assert.ok(r.tar.length > 1024);
    }
    assert.equal((buildCopyLayer(ctx, [{ src: '../escape', dest: '/' }]) as any).ok, false);
    assert.equal((buildCopyLayer(ctx, [{ src: 'nope.txt', dest: '/' }]) as any).ok, false);
    assert.equal((buildCopyLayer(ctx, []) as any).ok, false);
  });

  test('honors .dockerignore (no leak of ignored files), preserves source modes', () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, '.dockerignore'), 'node_modules\n.env\n*.log\n');
    fs.writeFileSync(path.join(ctx, 'index.html'), '<h1>');
    fs.writeFileSync(path.join(ctx, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(ctx, 'debug.log'), 'noise');
    fs.mkdirSync(path.join(ctx, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(ctx, 'node_modules', 'x', 'big.js'), '//');
    // nested ignored files (any-depth): a monorepo node_modules + a nested .env + nested log
    fs.mkdirSync(path.join(ctx, 'packages', 'foo', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(ctx, 'packages', 'foo', 'node_modules', 'dep.js'), '//');
    fs.mkdirSync(path.join(ctx, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ctx, 'src', '.env'), 'NESTED_SECRET=1');
    fs.writeFileSync(path.join(ctx, 'src', 'trace.log'), 'noise');
    fs.writeFileSync(path.join(ctx, 'src', 'app.js'), 'ok');
    fs.writeFileSync(path.join(ctx, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    const r = buildCopyLayer(ctx, [{ src: '.', dest: '/app', destIsDir: true }]);
    assert.ok(r.ok);
    if (r.ok) {
      const names = tarNames(r.tar);
      assert.ok(names.includes('app/index.html'), 'index.html should be present');
      assert.ok(names.includes('app/run.sh'), 'run.sh should be present');
      assert.ok(names.includes('app/src/app.js'), 'nested non-ignored file should be present');
      assert.ok(!names.some((n) => n.includes('.env')), '.env must be ignored (incl. nested src/.env)');
      assert.ok(!names.some((n) => n.includes('.log')), '*.log must be ignored at any depth');
      assert.ok(!names.some((n) => n.includes('node_modules')), 'node_modules must be ignored (incl. nested packages/foo/node_modules)');
      // run.sh keeps its 0755 mode (executable entrypoints must not be flattened to 0644).
      assert.equal(tarMode(r.tar, 'app/run.sh') & 0o777, 0o755);
      assert.equal(tarMode(r.tar, 'app/index.html') & 0o777, 0o644);
    }
  });

  test('honors .dockerignore for an explicitly-named file source (leak parity)', () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, '.dockerignore'), '.env\n');
    fs.writeFileSync(path.join(ctx, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(ctx, 'app.js'), 'ok');
    // Directly naming the ignored file must NOT package it.
    const r = buildCopyLayer(ctx, [{ src: '.env', dest: '/app/', destIsDir: true }, { src: 'app.js', dest: '/app/', destIsDir: true }]);
    assert.ok(r.ok);
    if (r.ok) {
      const names = tarNames(r.tar);
      assert.ok(names.includes('app/app.js'));
      assert.ok(!names.some((n) => n.includes('.env')), 'directly-COPYd .env must still be ignored');
    }
  });

  test('rejects a COPY source symlink that escapes the build context (no host leak)', () => {
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret'), 'HOST-SECRET');
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, 'ok.txt'), 'ok');
    try { fs.symlinkSync(path.join(outside, 'secret'), path.join(ctx, 'leak')); }
    catch { return; } // platform without symlink perms — skip
    const r = buildCopyLayer(ctx, [{ src: 'leak', dest: '/app/', destIsDir: true }]);
    assert.equal(r.ok, false);
    assert.match((r as any).message, /escapes the build context/);
  });

  test('deterministic — same input → identical bytes', () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, 'a.txt'), 'aaa');
    const a = buildCopyLayer(ctx, [{ src: 'a.txt', dest: '/x/' }]);
    const b = buildCopyLayer(ctx, [{ src: 'a.txt', dest: '/x/' }]);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.ok(a.tar.equals(b.tar));
  });
});

describe('applyDockerfileToConfig', () => {
  test('patches Cmd/WorkingDir/ExposedPorts + merges Env', () => {
    const cfg: Record<string, unknown> = { Env: ['PATH=/usr/bin', 'NODE_ENV=dev'] };
    applyDockerfileToConfig(cfg, {
      from: 'x', copies: [], cmd: ['node', 's.js'], entrypoint: null, workdir: '/app',
      user: 'node', exposes: ['8080/tcp'], env: [{ k: 'NODE_ENV', v: 'production' }, { k: 'PORT', v: '8080' }],
      assemblable: true, unsupported: [],
    });
    assert.deepEqual(cfg.Cmd, ['node', 's.js']);
    assert.equal(cfg.WorkingDir, '/app');
    assert.equal(cfg.User, 'node');
    assert.deepEqual(cfg.ExposedPorts, { '8080/tcp': {} });
    // NODE_ENV overridden in place, PATH kept, PORT appended.
    assert.deepEqual(cfg.Env, ['PATH=/usr/bin', 'NODE_ENV=production', 'PORT=8080']);
  });
});

describe('assembleOciArchive', () => {
  // Mock skopeo: `copy docker:// oci:` writes a minimal valid base layout;
  // `copy oci: oci-archive:` validates digest-consistency then writes the archive.
  function mockSkopeo(exportChecks: { ran: boolean }) {
    return async (file: string, args: string[]) => {
      assert.equal(file, 'skopeo');
      const [, , src, dst] = args; // copy --quiet <src> <dst>
      if (src.startsWith('docker://')) {
        const layoutDir = dst.slice('oci:'.length).split(':')[0];
        fs.mkdirSync(path.join(layoutDir, 'blobs', 'sha256'), { recursive: true });
        fs.writeFileSync(path.join(layoutDir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
        const config = { architecture: 'amd64', os: 'linux', config: { Env: ['PATH=/usr/bin'] }, rootfs: { type: 'layers', diff_ids: ['sha256:' + 'b'.repeat(64)] }, history: [] };
        const cBuf = Buffer.from(JSON.stringify(config));
        const cDig = sha(cBuf);
        fs.writeFileSync(path.join(layoutDir, 'blobs', 'sha256', cDig.replace('sha256:', '')), cBuf);
        // a (fake) base layer blob so layer-existence checks pass
        fs.writeFileSync(path.join(layoutDir, 'blobs', 'sha256', 'b'.repeat(64)), Buffer.from('baselayer'));
        const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: cDig, size: cBuf.length }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: 'sha256:' + 'b'.repeat(64), size: 9 }] };
        const mBuf = Buffer.from(JSON.stringify(manifest));
        const mDig = sha(mBuf);
        fs.writeFileSync(path.join(layoutDir, 'blobs', 'sha256', mDig.replace('sha256:', '')), mBuf);
        fs.writeFileSync(path.join(layoutDir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: mDig, size: mBuf.length, annotations: { 'org.opencontainers.image.ref.name': '1.0.0' } }] }));
        return { code: 0, stderr: '' };
      }
      // export: validate digest-consistency of the patched layout
      const layoutDir = src.slice('oci:'.length).split(':')[0];
      const blob = (d: string) => fs.readFileSync(path.join(layoutDir, 'blobs', 'sha256', d.replace('sha256:', '')));
      const idx = JSON.parse(fs.readFileSync(path.join(layoutDir, 'index.json'), 'utf-8'));
      const md = idx.manifests[0];
      const mBuf = blob(md.digest);
      assert.equal(sha(mBuf), md.digest, 'index→manifest digest mismatch');
      const man = JSON.parse(mBuf.toString());
      const cBuf = blob(man.config.digest);
      assert.equal(sha(cBuf), man.config.digest, 'manifest→config digest mismatch');
      for (const l of man.layers) assert.ok(fs.existsSync(path.join(layoutDir, 'blobs', 'sha256', l.digest.replace('sha256:', ''))), 'missing layer blob');
      const outPath = dst.slice('oci-archive:'.length).split(':')[0];
      fs.writeFileSync(outPath, 'ARCHIVE');
      exportChecks.ran = true;
      return { code: 0, stderr: '' };
    };
  }

  test('appends a COPY layer + patches config, producing a consistent archive', async () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, 'index.html'), '<h1>hi</h1>');
    const layoutDir = tmp();
    const outArchive = path.join(tmp(), 'out.tar');
    const parsed = parseDockerfile('FROM base:1\nCOPY index.html /app/\nWORKDIR /app\nEXPOSE 8080\nCMD ["node","s.js"]');
    const checks = { ran: false };
    const r = await assembleOciArchive({
      baseRef: parsed.from!, contextDir: ctx, parsed, ociLayoutDir: layoutDir,
      outArchivePath: outArchive, tag: '1.0.0', exec: mockSkopeo(checks), log: () => {},
    });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(checks.ran, true);
    assert.ok(fs.existsSync(outArchive));
    // The patched config (read via the new index) has our Cmd + 2 diff_ids (base + COPY).
    const idx = JSON.parse(fs.readFileSync(path.join(layoutDir, 'index.json'), 'utf-8'));
    const man = JSON.parse(fs.readFileSync(path.join(layoutDir, 'blobs', 'sha256', idx.manifests[0].digest.replace('sha256:', '')), 'utf-8'));
    assert.equal(man.layers.length, 2);
    const cfg = JSON.parse(fs.readFileSync(path.join(layoutDir, 'blobs', 'sha256', man.config.digest.replace('sha256:', '')), 'utf-8'));
    assert.deepEqual(cfg.config.Cmd, ['node', 's.js']);
    assert.equal(cfg.config.WorkingDir, '/app');
    assert.deepEqual(cfg.config.ExposedPorts, { '8080/tcp': {} });
    assert.equal(cfg.rootfs.diff_ids.length, 2);
  });

  test('FROM scratch assembles with NO skopeo pull (synthesized empty base)', async () => {
    const ctx = tmp();
    fs.writeFileSync(path.join(ctx, 'app'), 'BINARY');
    const layoutDir = tmp();
    const outArchive = path.join(tmp(), 'out.tar');
    const parsed = parseDockerfile('FROM scratch\nCOPY app /app\nCMD ["/app"]');
    const srcs: string[] = [];
    const checks = { ran: false };
    const skopeo = mockSkopeo(checks);
    const exec = async (f: string, a: string[]) => { srcs.push(a[2]); return skopeo(f, a); };
    const r = await assembleOciArchive({
      baseRef: parsed.from!, contextDir: ctx, parsed, ociLayoutDir: layoutDir,
      outArchivePath: outArchive, tag: '1.0.0', exec, log: () => {},
    });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(checks.ran, true, 'export should run');
    assert.ok(!srcs.some((s) => s.startsWith('docker://')), 'scratch must NOT skopeo-pull a base');
    // exactly one layer (the COPY), built on the synthesized empty base.
    const idx = JSON.parse(fs.readFileSync(path.join(layoutDir, 'index.json'), 'utf-8'));
    const man = JSON.parse(fs.readFileSync(path.join(layoutDir, 'blobs', 'sha256', idx.manifests[0].digest.replace('sha256:', '')), 'utf-8'));
    assert.equal(man.layers.length, 1);
  });

  test('surfaces a skopeo base-pull failure', async () => {
    const parsed = parseDockerfile('FROM base:1\nCOPY x /');
    const r = await assembleOciArchive({
      baseRef: 'base:1', contextDir: tmp(), parsed, ociLayoutDir: tmp(),
      outArchivePath: path.join(tmp(), 'o.tar'), tag: '1.0.0',
      exec: async () => ({ code: 1, stderr: 'no such image' }), log: () => {},
    });
    assert.equal(r.ok, false);
    assert.match((r as any).message, /skopeo pull/);
  });
});
