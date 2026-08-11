import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

describe('AgentRuntime -- provider-qualified Codex cleanup', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => runtime?.dispose());

  function start(sessionId: string, source?: string): void {
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: path.join(os.tmpdir(), 'pixel-codex-cleanup'),
      source,
    });
  }

  it('removes the Codex route on SessionEnd so the same ID can be adopted again', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    start('codex-restart');
    expect(store.size).toBe(1);
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionEnd',
      session_id: 'codex-restart',
      reason: 'exit',
    });
    expect(store.size).toBe(0);

    start('codex-restart');
    expect(store.size).toBe(1);
    expect([...store.values()][0].providerId).toBe(codexProvider.id);
  });

  it('manual external close removes a Codex route and permits re-adoption', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    start('codex-manual-close');
    const agent = [...store.values()][0];
    runtime.removeAgent(agent.id);
    expect(store.size).toBe(0);

    start('codex-manual-close');
    expect(store.size).toBe(1);
    expect([...store.values()][0].providerId).toBe('codex');
  });

  it('Watch All Sessions removal clears a Codex route and permits re-adoption', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    start('codex-watch-all');
    const externalAgents = [...store].filter(([, agent]) => agent.isExternal);
    for (const [id] of externalAgents) runtime.removeAgent(id);
    runtime.watchAllSessions.current = false;
    expect(store.size).toBe(0);

    runtime.watchAllSessions.current = true;
    start('codex-watch-all');
    expect(store.size).toBe(1);
  });

  it('keeps a same-ID Claude route isolated when Codex is removed and re-adopted', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    start('shared-provider-id');
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'shared-provider-id',
      source: 'startup',
      transcript_path: path.join(os.tmpdir(), 'shared-provider-id.jsonl'),
      cwd: path.join(os.tmpdir(), 'pixel-claude-isolation'),
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'shared-provider-id',
    });
    expect(store.size).toBe(2);

    const codexAgent = [...store.values()].find((agent) => agent.providerId === 'codex');
    const claudeAgent = [...store.values()].find(
      (agent) => (agent.providerId ?? 'claude') === 'claude',
    );
    expect(codexAgent).toBeDefined();
    expect(claudeAgent).toBeDefined();
    runtime.removeAgent(codexAgent!.id);

    runtime.handleHookEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'shared-provider-id',
    });
    expect(store.get(claudeAgent!.id)?.permissionSent).toBe(true);

    start('shared-provider-id');
    expect(store.size).toBe(2);
    expect([...store.values()].filter((agent) => agent.providerId === 'codex')).toHaveLength(1);
  });

  it('reassigns a cleared Codex session without leaving either route stale', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;

    start('codex-before-clear');
    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionEnd',
      session_id: 'codex-before-clear',
      reason: 'clear',
    });
    start('codex-after-clear', 'clear');
    expect([...store.values()][0].sessionId).toBe('codex-after-clear');

    runtime.handleHookEvent('codex', {
      hook_event_name: 'SessionEnd',
      session_id: 'codex-after-clear',
      reason: 'exit',
    });
    expect(store.size).toBe(0);
    start('codex-after-clear');
    expect(store.size).toBe(1);
  });
});
