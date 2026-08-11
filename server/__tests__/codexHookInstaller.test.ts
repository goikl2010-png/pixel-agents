import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  areHooksInstalled,
  installHooks,
  uninstallHooks,
} from '../src/providers/hook/codex/codexHookInstaller.js';
import { CODEX_HOOK_EVENTS } from '../src/providers/hook/codex/constants.js';

describe('Codex hook installer', () => {
  let dir: string;
  let config: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-codex-'));
    config = path.join(dir, 'hooks.json');
    process.env.PIXEL_AGENTS_CODEX_HOOKS_PATH = config;
    process.env.PIXEL_AGENTS_CODEX_HOOK_SCRIPT_PATH = path.join(dir, 'codex-hook.js');
  });
  afterEach(() => {
    delete process.env.PIXEL_AGENTS_CODEX_HOOKS_PATH;
    delete process.env.PIXEL_AGENTS_CODEX_HOOK_SCRIPT_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves unrelated hooks and is idempotent and reversible', () => {
    fs.writeFileSync(
      config,
      JSON.stringify({ custom: true, hooks: { SessionStart: [{ command: 'other' }] } }),
    );
    installHooks();
    installHooks();
    const installed = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect(installed.custom).toBe(true);
    expect(
      installed.hooks.SessionStart.filter((e: { command: string }) => e.command === 'other'),
    ).toHaveLength(1);
    for (const event of CODEX_HOOK_EVENTS)
      expect(installed.hooks[event]).toHaveLength(event === 'SessionStart' ? 2 : 1);
    expect(areHooksInstalled()).toBe(true);
    uninstallHooks();
    uninstallHooks();
    const removed = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect(removed).toEqual({ custom: true, hooks: { SessionStart: [{ command: 'other' }] } });
  });
});
