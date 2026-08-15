import { expect, it } from 'vitest';

import type { ActionableTask, TaskDiscoveryResult } from '../src/actionableTaskDiscovery.js';
import { LIFECYCLE_STATES, type LifecycleState } from '../src/handoffTransitionPlanner.js';
import { NEXT_HANDOFF_REASON, selectNextHandoff } from '../src/nextHandoffSelector.js';

const owners = {
  BACKLOG: 'Alex',
  DEVELOPMENT: 'Nova',
  READY_FOR_QA: 'Pixel',
  QA: 'Pixel',
  CHANGES_REQUIRED: 'Nova',
  QA_RETEST: 'Pixel',
  READY_FOR_REVIEW: 'Atlas',
  REVIEW: 'Atlas',
  APPROVED: 'Alex',
  COMPLETED: 'Alex',
  BLOCKED: 'Alex',
} as const;

function found(
  state: LifecycleState,
  overrides: Partial<ActionableTask> = {},
): Extract<TaskDiscoveryResult, { outcome: 'found' }> {
  return {
    outcome: 'found',
    task: {
      taskId: 'TASK-009',
      owner: owners[state],
      currentState: state,
      sourcePath: 'C:\\AI-Company\\tasks\\active\\task.md',
      sourceStorage:
        state === 'BACKLOG' ? 'backlog' : state === 'DEVELOPMENT' ? 'active' : 'review',
      ...(state === 'BLOCKED' ? { resumeState: 'QA' } : {}),
      ...overrides,
    },
  };
}

it.each([
  ['BACKLOG', 'DEVELOPMENT', 'Nova', 'active'],
  ['DEVELOPMENT', 'READY_FOR_QA', 'Pixel', 'review'],
  ['CHANGES_REQUIRED', 'QA_RETEST', 'Pixel', 'review'],
  ['READY_FOR_REVIEW', 'REVIEW', 'Atlas', 'review'],
] as const)(
  'selects canonical unique successor for %s',
  (sourceState, targetState, targetOwner, destinationStorage) => {
    expect(selectNextHandoff(found(sourceState))).toEqual({
      taskId: 'TASK-009',
      sourcePath: 'C:\\AI-Company\\tasks\\active\\task.md',
      sourceStorage:
        sourceState === 'BACKLOG' ? 'backlog' : sourceState === 'DEVELOPMENT' ? 'active' : 'review',
      sourceState,
      sourceOwner: owners[sourceState],
      selected: true,
      targetState,
      targetOwner,
      destinationStorage,
      reasonCode: NEXT_HANDOFF_REASON.selected,
      reason: `Selected the sole authorized safe successor ${sourceState} -> ${targetState}; authorization, evidence, and execution remain separate.`,
    });
  },
);

it.each(['READY_FOR_QA', 'QA', 'QA_RETEST', 'REVIEW'] as const)(
  'refuses role-owned progression from %s',
  (state) => {
    expect(selectNextHandoff(found(state))).toMatchObject({
      selected: false,
      sourceState: state,
      targetState: null,
      reasonCode: NEXT_HANDOFF_REASON.decisionOwned,
    });
  },
);

it.each([
  ['APPROVED', NEXT_HANDOFF_REASON.alexAuthority],
  ['BLOCKED', NEXT_HANDOFF_REASON.alexAuthority],
  ['COMPLETED', NEXT_HANDOFF_REASON.terminal],
] as const)('refuses protected state %s', (state, reasonCode) => {
  expect(selectNextHandoff(found(state))).toMatchObject({ selected: false, reasonCode });
});

it.each<TaskDiscoveryResult>([
  { outcome: 'none', employee: 'Nova' },
  { outcome: 'conflict', employee: 'Nova', tasks: [found('DEVELOPMENT').task] },
  { outcome: 'error', employee: 'Nova', errors: ['bad record'] },
])('fails closed for $outcome discovery', (discovery) => {
  expect(selectNextHandoff(discovery)).toMatchObject({
    selected: false,
    taskId: null,
    reasonCode: NEXT_HANDOFF_REASON.discoveryNotFound,
  });
});

it.each([
  found('DEVELOPMENT', { owner: 'Pixel' }),
  found('DEVELOPMENT', { currentState: 'UNKNOWN' }),
  found('DEVELOPMENT', { sourceStorage: 'elsewhere' as 'active' }),
  found('DEVELOPMENT', { taskId: ' ' }),
  found('DEVELOPMENT', { resumeState: 'QA' }),
])('fails closed for malformed or contradictory found input', (discovery) => {
  expect(selectNextHandoff(discovery)).toMatchObject({
    selected: false,
    reasonCode: NEXT_HANDOFF_REASON.invalidFoundTask,
  });
});

it('is byte-deterministic and does not mutate discovery input', () => {
  const discovery = found('DEVELOPMENT');
  const before = JSON.stringify(discovery);
  const first = JSON.stringify(selectNextHandoff(discovery));
  const second = JSON.stringify(selectNextHandoff(discovery));
  expect(second).toBe(first);
  expect(JSON.stringify(discovery)).toBe(before);
});

it('covers every canonical lifecycle source state', () => {
  expect(LIFECYCLE_STATES.map((state) => selectNextHandoff(found(state)).sourceState)).toEqual(
    LIFECYCLE_STATES,
  );
});
