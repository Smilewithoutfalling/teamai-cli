import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default function prepareOpencode(): void {
  execFileSync(process.execPath, ['node_modules/opencode-ai/postinstall.mjs'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
}
