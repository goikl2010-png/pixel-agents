import {
  EMPLOYEE_IDENTITIES,
  type EmployeeIdentity,
  type TaskDiscoveryResult,
  type TaskStorageClass,
} from './actionableTaskDiscovery.js';

export const LIFECYCLE_STATES = [
  'BACKLOG',
  'DEVELOPMENT',
  'READY_FOR_QA',
  'QA',
  'CHANGES_REQUIRED',
  'QA_RETEST',
  'READY_FOR_REVIEW',
  'REVIEW',
  'APPROVED',
  'COMPLETED',
  'BLOCKED',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type AuthoritativeStorageClass = TaskStorageClass | 'completed';

const STATE_OWNER: Readonly<Record<LifecycleState, EmployeeIdentity>> = {
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
};

const ALLOWED: Readonly<
  Record<Exclude<LifecycleState, 'BLOCKED' | 'COMPLETED'>, readonly LifecycleState[]>
> = {
  BACKLOG: ['DEVELOPMENT', 'BLOCKED'],
  DEVELOPMENT: ['READY_FOR_QA', 'BLOCKED'],
  READY_FOR_QA: ['QA', 'BLOCKED'],
  QA: ['READY_FOR_REVIEW', 'CHANGES_REQUIRED', 'BLOCKED'],
  CHANGES_REQUIRED: ['QA_RETEST', 'BLOCKED'],
  QA_RETEST: ['READY_FOR_REVIEW', 'CHANGES_REQUIRED', 'BLOCKED'],
  READY_FOR_REVIEW: ['REVIEW', 'BLOCKED'],
  REVIEW: ['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED'],
  APPROVED: ['COMPLETED', 'BLOCKED'],
};

export interface BlockedEntryInput {
  reporter: EmployeeIdentity;
  blocker: string;
  resolution: string;
  evidence: string;
  resumeState: string;
}

export interface TransitionPlanInput {
  discovery: TaskDiscoveryResult;
  requestedTargetState: string;
  blockedEntry?: BlockedEntryInput;
  alexAuthorizedResume?: boolean;
}

export interface TransitionPlan {
  taskId: string | null;
  sourcePath: string | null;
  sourceStorage: AuthoritativeStorageClass | null;
  sourceState: string | null;
  sourceOwner: EmployeeIdentity | null;
  requestedTargetState: string;
  targetOwner: EmployeeIdentity | null;
  legal: boolean;
  reason: string;
  destinationStorage: AuthoritativeStorageClass | null;
}

export function storageForLifecycleState(state: LifecycleState): AuthoritativeStorageClass | null {
  if (state === 'BACKLOG') return 'backlog';
  if (state === 'DEVELOPMENT' || state === 'CHANGES_REQUIRED') return 'active';
  if (state === 'COMPLETED') return 'completed';
  if (state === 'BLOCKED') return null;
  return 'review';
}

function isState(value: string): value is LifecycleState {
  return LIFECYCLE_STATES.includes(value as LifecycleState);
}

function baseIllegal(requestedTargetState: string, reason: string): TransitionPlan {
  return {
    taskId: null,
    sourcePath: null,
    sourceStorage: null,
    sourceState: null,
    sourceOwner: null,
    requestedTargetState,
    targetOwner: isState(requestedTargetState) ? STATE_OWNER[requestedTargetState] : null,
    legal: false,
    reason,
    destinationStorage: isState(requestedTargetState)
      ? storageForLifecycleState(requestedTargetState)
      : null,
  };
}

export function planHandoffTransition(input: TransitionPlanInput): TransitionPlan {
  const requestedTargetState = input.requestedTargetState;
  if (input.discovery.outcome !== 'found')
    return baseIllegal(
      requestedTargetState,
      `Discovery outcome ${input.discovery.outcome} cannot be planned; exactly one found task is required.`,
    );

  const task = input.discovery.task;
  const source = {
    taskId: task.taskId,
    sourcePath: task.sourcePath,
    sourceStorage: task.sourceStorage,
    sourceState: task.currentState,
    sourceOwner: task.owner,
  };
  const illegal = (
    reason: string,
    targetOwner: EmployeeIdentity | null = null,
    destinationStorage: AuthoritativeStorageClass | null = null,
  ): TransitionPlan => ({
    ...source,
    requestedTargetState,
    targetOwner,
    legal: false,
    reason,
    destinationStorage,
  });

  if (!task.taskId.trim() || !task.sourcePath.trim())
    return illegal('Found task identity/source is ambiguous.');
  if (!['backlog', 'active', 'review'].includes(task.sourceStorage))
    return illegal('Found task has an unsupported authoritative storage class.');
  if (!isState(task.currentState))
    return illegal(`Unsupported source state ${JSON.stringify(task.currentState)}.`);
  if (!EMPLOYEE_IDENTITIES.includes(task.owner) || STATE_OWNER[task.currentState] !== task.owner)
    return illegal(
      `Source state ${task.currentState} must be owned by ${STATE_OWNER[task.currentState]}.`,
    );
  if (!isState(requestedTargetState))
    return illegal(`Unsupported requested target state ${JSON.stringify(requestedTargetState)}.`);

  const targetOwner = STATE_OWNER[requestedTargetState];
  const destinationStorage =
    requestedTargetState === 'BLOCKED'
      ? task.sourceStorage
      : storageForLifecycleState(requestedTargetState);

  if (task.currentState === 'COMPLETED')
    return illegal(
      'COMPLETED is terminal and has no outbound transitions.',
      targetOwner,
      destinationStorage,
    );

  if (task.currentState === 'BLOCKED') {
    if (
      !task.resumeState ||
      !isState(task.resumeState) ||
      ['BLOCKED', 'COMPLETED'].includes(task.resumeState)
    )
      return illegal(
        'BLOCKED requires an exact saved nonterminal Resume state.',
        targetOwner,
        destinationStorage,
      );
    if (input.blockedEntry)
      return illegal(
        'Blocked-entry metadata is invalid when resuming a BLOCKED task.',
        targetOwner,
        destinationStorage,
      );
    if (requestedTargetState !== task.resumeState)
      return illegal(
        `BLOCKED may resume only to saved state ${task.resumeState}.`,
        targetOwner,
        destinationStorage,
      );
    if (input.alexAuthorizedResume !== true)
      return illegal(
        'BLOCKED resumption requires explicit Alex authorization.',
        targetOwner,
        destinationStorage,
      );
    return {
      ...source,
      requestedTargetState,
      targetOwner,
      legal: true,
      reason: 'Legal exact BLOCKED resume under Alex authorization.',
      destinationStorage,
    };
  }

  if (task.resumeState)
    return illegal(
      'Resume state metadata is only valid for BLOCKED tasks.',
      targetOwner,
      destinationStorage,
    );
  if (input.alexAuthorizedResume !== undefined)
    return illegal(
      'Alex resume authorization input is only valid for a BLOCKED source.',
      targetOwner,
      destinationStorage,
    );

  const allowed = ALLOWED[task.currentState];
  if (!allowed.includes(requestedTargetState))
    return illegal(
      `Transition ${task.currentState} -> ${requestedTargetState} is not allowed.`,
      targetOwner,
      destinationStorage,
    );

  if (requestedTargetState === 'BLOCKED') {
    const metadata = input.blockedEntry;
    if (!metadata)
      return illegal(
        'Entering BLOCKED requires reporter, blocker, resolution, evidence, and Resume state metadata.',
        targetOwner,
        destinationStorage,
      );
    if (
      !EMPLOYEE_IDENTITIES.includes(metadata.reporter) ||
      !metadata.blocker.trim() ||
      !metadata.resolution.trim() ||
      !metadata.evidence.trim() ||
      metadata.resumeState !== task.currentState
    )
      return illegal(
        'Entering BLOCKED requires valid nonempty metadata and Resume state exactly equal to the source state.',
        targetOwner,
        destinationStorage,
      );
  } else if (input.blockedEntry) {
    return illegal(
      'Blocked-entry metadata is only valid when requesting BLOCKED.',
      targetOwner,
      destinationStorage,
    );
  }

  return {
    ...source,
    requestedTargetState,
    targetOwner,
    legal: true,
    reason: `Legal authoritative transition ${task.currentState} -> ${requestedTargetState}.`,
    destinationStorage,
  };
}
