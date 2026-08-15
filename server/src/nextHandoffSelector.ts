import type { EmployeeIdentity, TaskDiscoveryResult } from './actionableTaskDiscovery.js';
import {
  type AuthoritativeStorageClass,
  LIFECYCLE_STATES,
  planHandoffTransition,
} from './handoffTransitionPlanner.js';

export const NEXT_HANDOFF_REASON = {
  selected: 'UNIQUE_SAFE_SUCCESSOR',
  discoveryNotFound: 'DISCOVERY_NOT_FOUND',
  invalidFoundTask: 'INVALID_FOUND_TASK',
  decisionOwned: 'DECISION_OWNED_SUCCESSOR',
  alexAuthority: 'ALEX_AUTHORITY_REQUIRED',
  terminal: 'TERMINAL_STATE',
  noUniqueSafeSuccessor: 'NO_UNIQUE_SAFE_SUCCESSOR',
} as const;

type NextHandoffReasonCode = (typeof NEXT_HANDOFF_REASON)[keyof typeof NEXT_HANDOFF_REASON];

export interface NextHandoffSelection {
  taskId: string | null;
  sourcePath: string | null;
  sourceStorage: AuthoritativeStorageClass | null;
  sourceState: string | null;
  sourceOwner: EmployeeIdentity | null;
  selected: boolean;
  targetState: string | null;
  targetOwner: EmployeeIdentity | null;
  destinationStorage: AuthoritativeStorageClass | null;
  reasonCode: NextHandoffReasonCode;
  reason: string;
}

const AUTOMATIC_SOURCE_STATES = new Set([
  'BACKLOG',
  'DEVELOPMENT',
  'CHANGES_REQUIRED',
  'READY_FOR_REVIEW',
]);
const DECISION_OWNED_STATES = new Set(['READY_FOR_QA', 'QA', 'QA_RETEST', 'REVIEW']);

function refusal(
  reasonCode: NextHandoffReasonCode,
  reason: string,
  source: Partial<NextHandoffSelection> = {},
): NextHandoffSelection {
  return {
    taskId: null,
    sourcePath: null,
    sourceStorage: null,
    sourceState: null,
    sourceOwner: null,
    selected: false,
    targetState: null,
    targetOwner: null,
    destinationStorage: null,
    reasonCode,
    reason,
    ...source,
  };
}

export function selectNextHandoff(discovery: TaskDiscoveryResult): NextHandoffSelection {
  if (discovery.outcome !== 'found')
    return refusal(
      NEXT_HANDOFF_REASON.discoveryNotFound,
      `Discovery outcome ${discovery.outcome} cannot select a successor; exactly one found task is required.`,
    );

  const task = discovery.task;
  const source = {
    taskId: task.taskId,
    sourcePath: task.sourcePath,
    sourceStorage: task.sourceStorage,
    sourceState: task.currentState,
    sourceOwner: task.owner,
  };

  // Ask the canonical TASK-007 planner about every possible target. This keeps
  // lifecycle legality, ownership, and destination storage in one model.
  const safePlans = LIFECYCLE_STATES.filter(
    (target) => target !== 'BLOCKED' && target !== 'COMPLETED',
  )
    .map((requestedTargetState) => planHandoffTransition({ discovery, requestedTargetState }))
    .filter((plan) => plan.legal);

  if (safePlans.length === 0) {
    const validation = planHandoffTransition({
      discovery,
      requestedTargetState: task.currentState,
    });
    if (
      !task.taskId.trim() ||
      !task.sourcePath.trim() ||
      validation.reason.startsWith('Unsupported source state') ||
      validation.reason.startsWith('Source state') ||
      validation.reason.includes('unsupported authoritative storage') ||
      validation.reason.includes('ambiguous') ||
      validation.reason.includes('Resume state metadata')
    )
      return refusal(NEXT_HANDOFF_REASON.invalidFoundTask, validation.reason, source);
  }

  if (task.currentState === 'COMPLETED')
    return refusal(NEXT_HANDOFF_REASON.terminal, 'COMPLETED is terminal.', source);
  if (task.currentState === 'APPROVED' || task.currentState === 'BLOCKED')
    return refusal(
      NEXT_HANDOFF_REASON.alexAuthority,
      `${task.currentState} progression requires Alex authority and cannot be selected automatically.`,
      source,
    );
  if (DECISION_OWNED_STATES.has(task.currentState))
    return refusal(
      NEXT_HANDOFF_REASON.decisionOwned,
      `${task.currentState} progression requires role-owned acceptance, evidence, or judgment.`,
      source,
    );
  if (!AUTOMATIC_SOURCE_STATES.has(task.currentState) || safePlans.length !== 1)
    return refusal(
      NEXT_HANDOFF_REASON.noUniqueSafeSuccessor,
      `Source state ${task.currentState} does not have exactly one authorized safe successor.`,
      source,
    );

  const plan = safePlans[0];
  return {
    ...source,
    selected: true,
    targetState: plan.requestedTargetState,
    targetOwner: plan.targetOwner,
    destinationStorage: plan.destinationStorage,
    reasonCode: NEXT_HANDOFF_REASON.selected,
    reason: `Selected the sole authorized safe successor ${task.currentState} -> ${plan.requestedTargetState}; authorization, evidence, and execution remain separate.`,
  };
}
