/**
 * `findAncestorDeployLink` — the upward walk behind `init`'s inferred parent
 * (hosting nesting plan §10 S4).
 *
 * The stop conditions ARE the feature. An unbounded walk would adopt projects
 * across repo boundaries and, in the worst case, make one stray
 * `~/.yolo/deploy.json` the parent of every project on the machine. Nearly every
 * test here pins a place the walk must REFUSE to go.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { findAncestorDeployLink } from './deploy-config.js';

/** In-memory tree: map of absolute path → file contents. */
function tree(files: Record<string, string>, dirs: string[] = []) {
  const read = (p: string): string | undefined => files[p];
  const exists = (p: string): boolean => p in files || dirs.includes(p);
  return { read, exists };
}

const link = (id: string, slug?: string) =>
  JSON.stringify({ projectId: id, ...(slug ? { slug } : {}) });

describe('findAncestorDeployLink', () => {
  it('finds the nearest linked ancestor', () => {
    const t = tree({ '/repo/.yolo/deploy.json': link('a'.repeat(24), 'site') });
    const found = findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists });
    assert.equal(found?.projectId, 'a'.repeat(24));
    assert.equal(found?.slug, 'site');
    assert.equal(found?.dir, '/repo');
    assert.equal(found?.path, path.join('/repo', '.yolo', 'deploy.json'));
  });

  it('prefers the NEAREST ancestor over a further one', () => {
    const t = tree({
      '/repo/.yolo/deploy.json': link('a'.repeat(24)),
      '/repo/apps/.yolo/deploy.json': link('b'.repeat(24)),
    });
    const found = findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists });
    assert.equal(found?.projectId, 'b'.repeat(24));
  });

  it('🚨 never returns cwd itself — a project must not become its own parent', () => {
    const t = tree({ '/repo/apps/api/.yolo/deploy.json': link('a'.repeat(24)) });
    assert.equal(findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists }), null);
  });

  it('🚨 stops at a .git boundary — a sibling repo is not a parent', () => {
    const t = tree(
      { '/outer/.yolo/deploy.json': link('a'.repeat(24)) },
      ['/outer/inner/.git'],
    );
    assert.equal(
      findAncestorDeployLink('/outer/inner/apps/api', t.read, { existsImpl: t.exists }),
      null,
      'the walk crossed out of its own repository',
    );
  });

  it('🚨 refuses to escape when cwd IS a repo root', () => {
    // `init` at the root of a nested repo would otherwise start the walk one
    // level above it and adopt a parent from the enclosing tree.
    const t = tree(
      { '/outer/.yolo/deploy.json': link('a'.repeat(24)) },
      ['/outer/inner/.git'],
    );
    assert.equal(findAncestorDeployLink('/outer/inner', t.read, { existsImpl: t.exists }), null);
  });

  it('🚨 still finds a deployed monorepo ROOT — .git stops AFTER the check', () => {
    // The common real case: the repo root is itself a hosting project.
    const t = tree(
      { '/repo/.yolo/deploy.json': link('a'.repeat(24), 'site') },
      ['/repo/.git'],
    );
    const found = findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists });
    assert.equal(found?.projectId, 'a'.repeat(24));
  });

  it('🚨 never inspects or passes $HOME — one stray file must not adopt the machine', () => {
    // Someone who once ran `init` in their home directory would otherwise have
    // every future project anywhere silently parented to it.
    const t = tree({ '/home/dev/.yolo/deploy.json': link('a'.repeat(24)) });
    assert.equal(
      findAncestorDeployLink('/home/dev/scratch/thing', t.read, { existsImpl: t.exists, home: '/home/dev' }),
      null,
    );
  });

  it('🚨 STILL WALKS inside $HOME — this is where almost every repo lives', () => {
    // The guard is a floor, not a fence. An earlier version tested "is dir
    // inside home" with the sense inverted, refusing every directory UNDER home
    // and silently disabling the whole feature for anyone whose repos live
    // there. Both home tests passed anyway, for the wrong reason.
    const t = tree({ '/home/dev/src/repo/.yolo/deploy.json': link('a'.repeat(24), 'site') });
    const found = findAncestorDeployLink(
      '/home/dev/src/repo/apps/api', t.read, { existsImpl: t.exists, home: '/home/dev' },
    );
    assert.equal(found?.projectId, 'a'.repeat(24), 'the walk must work inside the home directory');
    assert.equal(found?.dir, '/home/dev/src/repo');
  });

  it('does not confuse a sibling of home with home itself', () => {
    // `/home/developer2` must not be treated as inside `/home/dev`.
    const t = tree({ '/home/dev2/.yolo/deploy.json': link('a'.repeat(24)) });
    const found = findAncestorDeployLink('/home/dev2/app', t.read, { existsImpl: t.exists, home: '/home/dev' });
    assert.equal(found?.projectId, 'a'.repeat(24));
  });

  it('terminates at the filesystem root', () => {
    const t = tree({});
    assert.equal(findAncestorDeployLink('/a/b/c', t.read, { existsImpl: t.exists }), null);
  });

  it('respects the depth cap', () => {
    const deep = '/' + Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
    const t = tree({ '/.yolo/deploy.json': link('a'.repeat(24)) });
    assert.equal(findAncestorDeployLink(deep, t.read, { existsImpl: t.exists, maxDepth: 3 }), null);
  });

  it('🚨 keeps walking past a MALFORMED ancestor link rather than failing', () => {
    // That file belongs to another directory. Blocking a child's init on it
    // would stall someone on a problem they may not know exists.
    const t = tree({
      '/repo/apps/.yolo/deploy.json': '{ not json',
      '/repo/.yolo/deploy.json': link('a'.repeat(24)),
    });
    const found = findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists });
    assert.equal(found?.projectId, 'a'.repeat(24));
  });

  it('ignores an ancestor link that carries no projectId', () => {
    const t = tree({
      '/repo/apps/.yolo/deploy.json': JSON.stringify({ slug: 'unlinked' }),
      '/repo/.yolo/deploy.json': link('a'.repeat(24)),
    });
    assert.equal(findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists })?.projectId,
      'a'.repeat(24));
  });

  it('ignores an empty ancestor file', () => {
    const t = tree({ '/repo/apps/.yolo/deploy.json': '   ', '/repo/.yolo/deploy.json': link('a'.repeat(24)) });
    assert.equal(findAncestorDeployLink('/repo/apps/api', t.read, { existsImpl: t.exists })?.dir, '/repo');
  });
});
