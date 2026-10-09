import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * Commit what a fixture wrote into the team clone at `repoPath`, making it a
 * repository first if it is not one. A real team clone has history, and a
 * file teamai has no delivery record of is teamai's only when it holds a
 * version from that history (#993); a fixture whose team repo is a plain
 * directory proves nothing.
 */
export function commitTeamRepo(repoPath: string, message = 'fixture'): void {
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repoPath, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!fs.existsSync(path.join(repoPath, '.git'))) git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
}
