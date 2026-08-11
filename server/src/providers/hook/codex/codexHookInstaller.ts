import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_HOOK_EVENTS, CODEX_HOOK_SCRIPT_NAME } from './constants.js';

type HookEntry = { command?: string; [key: string]: unknown };
type HooksFile = { hooks?: Record<string, HookEntry[]>; [key: string]: unknown };
const configPath = () =>
  process.env.PIXEL_AGENTS_CODEX_HOOKS_PATH ?? path.join(os.homedir(), '.codex', 'hooks.json');
const scriptPath = () =>
  process.env.PIXEL_AGENTS_CODEX_HOOK_SCRIPT_PATH ??
  path.join(os.homedir(), '.pixel-agents', 'hooks', CODEX_HOOK_SCRIPT_NAME);
const command = () => `node "${scriptPath()}"`;
const ours = (entry: HookEntry) => entry.command === command();
function read(): HooksFile {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Codex hook configuration must be a JSON object');
    }
    const hooks = (value as HooksFile).hooks;
    if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) {
      throw new TypeError('Codex hooks must be a JSON object');
    }
    for (const event of CODEX_HOOK_EVENTS) {
      if (hooks?.[event] !== undefined && !Array.isArray(hooks[event])) {
        throw new TypeError(`Codex hook entries for ${event} must be an array`);
      }
    }
    return value as HooksFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot safely read Codex hook configuration at ${configPath()}`, {
      cause: error,
    });
  }
}
function writeAtomic(value: HooksFile): void {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}
export function installHooks(): void {
  const value = read();
  value.hooks ??= {};
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = Array.isArray(value.hooks[event]) ? value.hooks[event] : [];
    if (!entries.some(ours)) entries.push({ command: command() });
    value.hooks[event] = entries;
  }
  writeAtomic(value);
}
export function uninstallHooks(): void {
  const value = read();
  if (!value.hooks) return;
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = value.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !ours(entry));
    if (kept.length) value.hooks[event] = kept;
    else delete value.hooks[event];
  }
  if (!Object.keys(value.hooks).length) delete value.hooks;
  writeAtomic(value);
}
export function areHooksInstalled(): boolean {
  try {
    const hooks = read().hooks;
    return !!hooks && CODEX_HOOK_EVENTS.every((event) => hooks[event]?.some(ours));
  } catch {
    return false;
  }
}

export function copyCodexHookScript(extensionPath: string): boolean {
  const source = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const target = scriptPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(source)) return false;
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o700);
    return true;
  } catch {
    return false;
  }
}
