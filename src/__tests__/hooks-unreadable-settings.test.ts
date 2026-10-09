import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileHooks } from '../hooks.js';

/**
 * A hook settings file that does not parse is the member's to repair (#993):
 * teamai leaves it byte-identical and says which file, whatever the format.
 */
describe('reconcileHooks with a settings file that does not parse', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hooks-unreadable-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['claude', 'cursor', 'copilot', 'codex', 'zcode'])('leaves %s\'s file as it is and names it', async (tool) => {
    const file = path.join(dir, `${tool}-hooks.json`);
    const broken = '{ "hooks": {\n';
    fs.writeFileSync(file, broken);
    await expect(reconcileHooks(file, tool, [])).rejects.toThrow(`${file} does not parse`);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });
});
