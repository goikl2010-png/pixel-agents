import { describe, expect, it } from 'vitest';

import { codexProvider } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  it('normalizes the supported lifecycle independently', () => {
    expect(
      codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 's',
        cwd: '/work',
      })?.event,
    ).toEqual({ kind: 'sessionStart', source: undefined, cwd: '/work' });
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Stop', session_id: 's' })?.event,
    ).toEqual({ kind: 'turnEnd', awaitingInput: true });
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'SessionEnd', session_id: 's' })?.event
        .kind,
    ).toBe('sessionEnd');
  });

  it('correlates tool lifecycle by stable tool_use_id', () => {
    const start = codexProvider.normalizeHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      tool_use_id: 't1',
      tool_name: 'Read',
      tool_input: { path: '/x/a.ts' },
    });
    const end = codexProvider.normalizeHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_use_id: 't1',
    });
    expect(start?.event).toMatchObject({ kind: 'toolStart', toolId: 't1', toolName: 'Read' });
    expect(end?.event).toEqual({ kind: 'toolEnd', toolId: 't1' });
  });

  it('rejects malformed and unknown events safely', () => {
    expect(codexProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'Unknown', session_id: 's' }),
    ).toBeNull();
    expect(
      codexProvider.normalizeHookEvent({ hook_event_name: 'PreToolUse', session_id: 's' }),
    ).toBeNull();
  });
});
