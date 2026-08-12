export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';
export const CODEX_EMPLOYEE_IDENTITY_ENV = 'PIXEL_AGENTS_EMPLOYEE_IDENTITY';
export const CODEX_EMPLOYEE_IDENTITY_FIELD = 'pixel_agents_employee_identity';
export const CODEX_EMPLOYEE_IDENTITIES = ['Alex', 'Nova', 'Pixel', 'Atlas'] as const;
export type CodexEmployeeIdentity = (typeof CODEX_EMPLOYEE_IDENTITIES)[number];
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;
