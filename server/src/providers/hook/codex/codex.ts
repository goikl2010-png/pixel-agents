import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { areHooksInstalled, installHooks, uninstallHooks } from './codexHookInstaller.js';

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string' || !sessionId.trim())
    return null;
  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };
    case 'UserPromptSubmit':
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `prompt-${String(raw.turn_id ?? Date.now())}`,
          toolName: 'Prompt',
        },
      };
    case 'PreToolUse': {
      const toolId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined;
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
      return toolId && toolName
        ? { sessionId, event: { kind: 'toolStart', toolId, toolName, input: raw.tool_input } }
        : null;
    }
    case 'PostToolUse':
      return typeof raw.tool_use_id === 'string'
        ? { sessionId, event: { kind: 'toolEnd', toolId: raw.tool_use_id } }
        : null;
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };
    default:
      return null;
  }
}

function formatToolStatus(toolName: string, input?: unknown): string {
  const value = input as Record<string, unknown> | undefined;
  const target = value?.path ?? value?.file_path;
  return typeof target === 'string' ? `${toolName}: ${path.basename(target)}` : `Using ${toolName}`;
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'OpenAI Codex',
  protocolVersion: 1,
  normalizeHookEvent,
  installHooks: async () => installHooks(),
  uninstallHooks: async () => uninstallHooks(),
  areHooksInstalled: async () => areHooksInstalled(),
  formatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(['Read', 'Grep', 'Glob']),
  terminalNamePrefix: 'Codex',
};
