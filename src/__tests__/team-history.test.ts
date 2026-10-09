import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobIdOf, historicalContents, historicalVersions, matchesHistory } from '../utils/team-history.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1',
};

let repo: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
const commit = (files: Record<string, string | null>, message: string): void => {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(repo, rel);
    if (content === null) fs.rmSync(file);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
};

describe('team history proof', () => {
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-history-'));
    git('init', '-q', '-b', 'main');
    commit({ 'rules/a.md': 'A v1\n', 'skills/s/SKILL.md': 'S v1\n' }, 'one');
    commit({ 'rules/a.md': 'A v2\n', 'skills/s/ref.md': 'R v1\n' }, 'two');
    git('switch', '-q', '-c', 'side');
    commit({ 'rules/a.md': 'A side\n' }, 'side');
    git('switch', '-q', 'main');
    commit({ 'skills/s/SKILL.md': 'S v2\n' }, 'three');
    git('merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge', 'side');
    commit({ 'rules/a.md': null }, 'delete');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists every version each file under a path held, deleted ones included', async () => {
    const versions = await historicalVersions(repo, 'rules/a.md');
    const ids = await Promise.all(['A v1\n', 'A v2\n', 'A side\n'].map((c) => blobIdOf(repo, c)));
    expect(new Set(versions?.map((v) => v.blob))).toEqual(new Set(ids));
    expect(new Set(versions?.map((v) => v.path))).toEqual(new Set(['rules/a.md']));

    const skill = await historicalVersions(repo, 'skills/s');
    expect(new Set(skill?.map((v) => `${v.path} ${v.blob}`))).toEqual(new Set([
      `skills/s/SKILL.md ${await blobIdOf(repo, 'S v1\n')}`,
      `skills/s/SKILL.md ${await blobIdOf(repo, 'S v2\n')}`,
      `skills/s/ref.md ${await blobIdOf(repo, 'R v1\n')}`,
    ]));
    expect(await historicalVersions(repo, 'never/there.md')).toEqual([]);
  });

  it('computes the blob id git gives a content', async () => {
    fs.writeFileSync(path.join(repo, 'probe.txt'), 'probe\n');
    expect(await blobIdOf(repo, 'probe\n')).toBe(git('hash-object', 'probe.txt'));
    fs.rmSync(path.join(repo, 'probe.txt'));
  });

  it('tests a candidate against the versions, or against their render', async () => {
    expect(await matchesHistory(repo, 'rules/a.md', 'A v1\n')).toBe(true);
    expect(await matchesHistory(repo, 'rules/a.md', 'A edited\n')).toBe(false);
    const render = (content: Buffer): string => `# rendered\n${content.toString('utf8')}`;
    expect(await matchesHistory(repo, 'rules/a.md', '# rendered\nA side\n', render)).toBe(true);
    expect(await matchesHistory(repo, 'rules/a.md', 'A side\n', render)).toBe(false);
  });

  it('returns each version\'s content, and null outside a repository', async () => {
    const contents = await historicalContents(repo, 'skills/s/SKILL.md');
    expect(contents?.map((c) => c.content.toString('utf8')).sort()).toEqual(['S v1\n', 'S v2\n']);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-history-none-'));
    try {
      expect(await historicalVersions(outside, 'x')).toBeNull();
      expect(await matchesHistory(outside, 'x', 'y')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// #993: a link's blob is its target text, so it never proves a file, and a version
// that changed only its mode (file to link) is kept as its own version.
describe('links in the team history', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-history-links-'));
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'rules'));
    fs.writeFileSync(path.join(repo, 'rules', 'foo.md'), 'bar.md');
    git('add', '-A'); git('commit', '-q', '-m', 'file');
    fs.rmSync(path.join(repo, 'rules', 'foo.md'));
    fs.symlinkSync('bar.md', path.join(repo, 'rules', 'foo.md'));
    git('add', '-A'); git('commit', '-q', '-m', 'link');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('keeps both the file and the link version when only the mode changed', async () => {
    const modes = (await historicalVersions(repo, 'rules/foo.md'))!.map((v) => v.mode).sort();
    expect(modes).toEqual(['100644', '120000']);
  });

  it('proves a file only by a file the team had, not by a link with the same text', async () => {
    fs.symlinkSync('baz.md', path.join(repo, 'rules', 'only-link.md'));
    git('add', '-A'); git('commit', '-q', '-m', 'only a link');
    expect(await matchesHistory(repo, 'rules/only-link.md', 'baz.md')).toBe(false);
    // foo.md was once a regular file holding these bytes: that version proves it.
    expect(await matchesHistory(repo, 'rules/foo.md', 'bar.md')).toBe(true);
  });
});
