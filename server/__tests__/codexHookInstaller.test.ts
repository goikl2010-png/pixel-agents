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

  it('preserves malformed existing configuration instead of replacing it', () => {
    const malformed = '{ "hooks": invalid';
    fs.writeFileSync(config, malformed);

    expect(() => installHooks()).toThrow(/Cannot safely read Codex hook configuration/);
    expect(() => uninstallHooks()).toThrow(/Cannot safely read Codex hook configuration/);
    expect(areHooksInstalled()).toBe(false);
    expect(fs.readFileSync(config, 'utf8')).toBe(malformed);
  });

  it('preserves structurally invalid existing hook configuration', () => {
    const invalid = JSON.stringify({ custom: true, hooks: { SessionStart: { command: 'other' } } });
    fs.writeFileSync(config, invalid);

    expect(() => installHooks()).toThrow(/Cannot safely read Codex hook configuration/);
    expect(fs.readFileSync(config, 'utf8')).toBe(invalid);
  });

  it('does not write when existing configuration is unreadable', () => {
    const unreadable = path.join(dir, 'config-directory');
    fs.mkdirSync(unreadable);
    process.env.PIXEL_AGENTS_CODEX_HOOKS_PATH = unreadable;

    expect(() => installHooks()).toThrow(/Cannot safely read Codex hook configuration/);
    expect(fs.statSync(unreadable).isDirectory()).toBe(true);
    expect(fs.readdirSync(unreadable)).toEqual([]);
  });
});
