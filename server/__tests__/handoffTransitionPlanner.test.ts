import { expect, it } from 'vitest';

import type { ActionableTask, TaskDiscoveryResult } from '../src/actionableTaskDiscovery.js';
import {
  LIFECYCLE_STATES,
  type LifecycleState,
  planHandoffTransition,
} from '../src/handoffTransitionPlanner.js';

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
const storage = {
  BACKLOG: 'backlog',
  DEVELOPMENT: 'active',
  READY_FOR_QA: 'review',
  QA: 'review',
  CHANGES_REQUIRED: 'active',
  QA_RETEST: 'review',
  READY_FOR_REVIEW: 'review',
  REVIEW: 'review',
  APPROVED: 'review',
  COMPLETED: 'completed',
} as const;
const allowed: Array<[LifecycleState, LifecycleState]> = [
  ['BACKLOG', 'DEVELOPMENT'],
  ['DEVELOPMENT', 'READY_FOR_QA'],
  ['READY_FOR_QA', 'QA'],
  ['QA', 'READY_FOR_REVIEW'],
  ['QA', 'CHANGES_REQUIRED'],
  ['CHANGES_REQUIRED', 'QA_RETEST'],
  ['QA_RETEST', 'READY_FOR_REVIEW'],
  ['QA_RETEST', 'CHANGES_REQUIRED'],
  ['READY_FOR_REVIEW', 'REVIEW'],
  ['REVIEW', 'APPROVED'],
  ['REVIEW', 'CHANGES_REQUIRED'],
  ['APPROVED', 'COMPLETED'],
];

function found(
  state: LifecycleState,
  overrides: Partial<ActionableTask> = {},
): Extract<TaskDiscoveryResult, { outcome: 'found' }> {
  return {
    outcome: 'found',
    task: {
      taskId: 'TASK-007',
      owner: owners[state],
      currentState: state,
      sourcePath: 'C:\\AI-Company\\tasks\\active\\task.md',
      sourceStorage: 'active',
      ...overrides,
    },
  };
}

it.each(allowed)('plans allowed %s -> %s with exact owner and destination', (source, target) => {
  expect(
    planHandoffTransition({ discovery: found(source), requestedTargetState: target }),
  ).toMatchObject({
    taskId: 'TASK-007',
    sourceState: source,
    sourceOwner: owners[source],
    requestedTargetState: target,
    targetOwner: owners[target],
    legal: true,
    destinationStorage: storage[target as keyof typeof storage],
  });
});

it.each(
  LIFECYCLE_STATES.flatMap((source) =>
    LIFECYCLE_STATES.filter(
      (target) =>
        target !== 'BLOCKED' && !allowed.some(([from, to]) => from === source && to === target),
    ).map((target) => [source, target] as const),
  ),
)('fails closed for illegal/skipped/reversed %s -> %s', (source, target) => {
  expect(
    planHandoffTransition({ discovery: found(source), requestedTargetState: target }).legal,
  ).toBe(false);
});

it.each(LIFECYCLE_STATES.filter((state) => state !== 'BLOCKED' && state !== 'COMPLETED'))(
  'plans valid %s -> BLOCKED while retaining authoritative storage',
  (source) => {
    const result = planHandoffTransition({
      discovery: found(source, { sourceStorage: 'review' }),
      requestedTargetState: 'BLOCKED',
      blockedEntry: {
        reporter: owners[source],
        blocker: 'blocked',
        resolution: 'owner action',
        evidence: 'log',
        resumeState: source,
      },
    });
    expect(result).toMatchObject({
      legal: true,
      targetOwner: 'Alex',
      destinationStorage: 'review',
    });
  },
);

it.each([
  undefined,
  { reporter: 'Nova', blocker: '', resolution: 'fix', evidence: 'log', resumeState: 'DEVELOPMENT' },
  { reporter: 'Nova', blocker: 'x', resolution: '', evidence: 'log', resumeState: 'DEVELOPMENT' },
  { reporter: 'Nova', blocker: 'x', resolution: 'fix', evidence: '', resumeState: 'DEVELOPMENT' },
  { reporter: 'Nova', blocker: 'x', resolution: 'fix', evidence: 'log', resumeState: 'QA' },
] as const)('rejects missing/invalid BLOCKED entry metadata', (blockedEntry) => {
  expect(
    planHandoffTransition({
      discovery: found('DEVELOPMENT'),
      requestedTargetState: 'BLOCKED',
      ...(blockedEntry ? { blockedEntry } : {}),
    }).legal,
  ).toBe(false);
});

it('requires exact saved resume state and explicit Alex authorization', () => {
  const discovery = found('BLOCKED', { resumeState: 'QA', sourceStorage: 'review' });
  expect(planHandoffTransition({ discovery, requestedTargetState: 'QA' }).legal).toBe(false);
  expect(
    planHandoffTransition({ discovery, requestedTargetState: 'REVIEW', alexAuthorizedResume: true })
      .legal,
  ).toBe(false);
  expect(
    planHandoffTransition({ discovery, requestedTargetState: 'QA', alexAuthorizedResume: true }),
  ).toMatchObject({
    legal: true,
    targetOwner: 'Pixel',
    destinationStorage: 'review',
  });
});

it.each<TaskDiscoveryResult>([
  { outcome: 'none', employee: 'Nova' },
  {
    outcome: 'conflict',
    employee: 'Nova',
    tasks: [found('DEVELOPMENT').task],
  },
  { outcome: 'error', employee: 'Nova', errors: ['bad record'] },
])('fails closed for $outcome discovery', (discovery) => {
  expect(planHandoffTransition({ discovery, requestedTargetState: 'READY_FOR_QA' })).toMatchObject({
    legal: false,
    taskId: null,
  });
});

it.each([
  found('DEVELOPMENT', { owner: 'Pixel' }),
  found('DEVELOPMENT', { currentState: 'UNKNOWN' }),
  found('DEVELOPMENT', { sourceStorage: 'elsewhere' as 'active' }),
  found('DEVELOPMENT', { taskId: ' ' }),
])('fails closed for contradictory or ambiguous found tasks', (discovery) => {
  expect(planHandoffTransition({ discovery, requestedTargetState: 'READY_FOR_QA' }).legal).toBe(
    false,
  );
});

it('is deterministic and does not mutate its discovery input', () => {
  const discovery = found('DEVELOPMENT');
  const before = JSON.stringify(discovery);
  const first = planHandoffTransition({ discovery, requestedTargetState: 'READY_FOR_QA' });
  const second = planHandoffTransition({ discovery, requestedTargetState: 'READY_FOR_QA' });
  expect(first).toEqual(second);
  expect(JSON.stringify(discovery)).toBe(before);
});
