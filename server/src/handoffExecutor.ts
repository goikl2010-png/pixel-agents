import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import {
  discoverActionableTask,
  type EmployeeIdentity,
  type TaskDiscoveryResult,
  type TaskLocations,
} from './actionableTaskDiscovery.js';
import { planHandoffTransition, type TransitionPlan } from './handoffTransitionPlanner.js';

export interface HandoffEvidence {
  actor: EmployeeIdentity;
  recipient: EmployeeIdentity;
  timestamp: string;
  evidence: string;
  nextAction: string;
}

export interface HandoffExecutionInput {
  discovery: TaskDiscoveryResult;
  plan: TransitionPlan;
  locations: TaskLocations;
  expectedSourceHash: string;
  handoff: HandoffEvidence;
}

export interface HandoffExecutionResult {
  taskId: string | null;
  sourceState: string | null;
  targetState: string | null;
  sourceOwner: EmployeeIdentity | null;
  targetOwner: EmployeeIdentity | null;
  sourcePath: string | null;
  destinationPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  success: boolean;
  reason: string;
}

export interface HandoffFileSystem {
  readFile(file: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    file: string,
    content: string,
    options: { encoding: BufferEncoding; flag: 'wx' },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(file: string): Promise<void>;
  stat(file: string): Promise<unknown>;
}

const defaultFileSystem: HandoffFileSystem = {
  readFile: (file, encoding) => fs.readFile(file, encoding),
  writeFile: (file, content, options) => fs.writeFile(file, content, options),
  rename: (source, destination) => fs.rename(source, destination),
  unlink: (file) => fs.unlink(file),
  stat: (file) => fs.stat(file),
};

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function failure(
  input: HandoffExecutionInput,
  reason: string,
  beforeHash: string | null = null,
  destinationPath: string | null = null,
): HandoffExecutionResult {
  const task = input.discovery.outcome === 'found' ? input.discovery.task : null;
  return {
    taskId: task?.taskId ?? null,
    sourceState: task?.currentState ?? null,
    targetState: input.plan.requestedTargetState || null,
    sourceOwner: task?.owner ?? null,
    targetOwner: input.plan.targetOwner,
    sourcePath: task?.sourcePath ?? null,
    destinationPath,
    beforeHash,
    afterHash: null,
    success: false,
    reason,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function exists(file: string, fileSystem: HandoffFileSystem): Promise<boolean> {
  try {
    await fileSystem.stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function replaceUniqueField(markdown: string, field: string, value: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^(\\s*-?\\s*\\*\\*${escaped}:\\*\\*\\s*).+?$`, 'gim');
  const matches = [...markdown.matchAll(regex)];
  if (matches.length !== 1) throw new Error(`expected exactly one ${field} field`);
  return markdown.replace(regex, `$1${value}`);
}

function oneLine(value: string): boolean {
  return value.trim().length > 0 && !/[\r\n|]/.test(value);
}

function updateRecord(markdown: string, plan: TransitionPlan, handoff: HandoffEvidence): string {
  let updated = replaceUniqueField(markdown, 'Previous state', plan.sourceState!);
  updated = replaceUniqueField(updated, 'Current state', plan.requestedTargetState);
  updated = replaceUniqueField(updated, 'Owner', plan.targetOwner!);
  updated = replaceUniqueField(updated, 'Resume state (required only when BLOCKED)', 'None');

  const sectionMatches = [...updated.matchAll(/^## Handoff History\s*$/gim)];
  if (sectionMatches.length !== 1) throw new Error('expected exactly one Handoff History section');
  const sectionStart = sectionMatches[0].index! + sectionMatches[0][0].length;
  const nextSection = updated.slice(sectionStart).search(/^##\s+/m);
  const sectionEnd = nextSection < 0 ? updated.length : sectionStart + nextSection;
  const section = updated.slice(sectionStart, sectionEnd);
  if (
    !/^\|\s*Date\/time\s*\|\s*From\s*\|\s*To\s*\|\s*State transition\s*\|\s*Evidence verified or supplied\s*\|\s*Next required action\s*\|\s*$/im.test(
      section,
    )
  )
    throw new Error('malformed Handoff History table');
  const newline = updated.includes('\r\n') ? '\r\n' : '\n';
  const row = `| ${handoff.timestamp.trim()} | ${handoff.actor} | ${handoff.recipient} | \`${plan.sourceState}\` to \`${plan.requestedTargetState}\` | ${handoff.evidence.trim()} | ${handoff.nextAction.trim()} |`;
  const before = updated.slice(0, sectionEnd).replace(/[\r\n]*$/, '');
  const after = updated.slice(sectionEnd);
  return `${before}${newline}${row}${newline}${nextSection < 0 ? '' : newline}${after}`;
}

function samePlan(first: TransitionPlan, second: TransitionPlan): boolean {
  return (
    first.legal === second.legal &&
    first.taskId === second.taskId &&
    first.sourcePath === second.sourcePath &&
    first.sourceStorage === second.sourceStorage &&
    first.sourceState === second.sourceState &&
    first.sourceOwner === second.sourceOwner &&
    first.requestedTargetState === second.requestedTargetState &&
    first.targetOwner === second.targetOwner &&
    first.destinationStorage === second.destinationStorage
  );
}

export async function executeHandoff(
  input: HandoffExecutionInput,
  fileSystem: HandoffFileSystem = defaultFileSystem,
): Promise<HandoffExecutionResult> {
  if (input.discovery.outcome !== 'found')
    return failure(input, 'Execution requires exactly one found discovery result.');
  if (!input.plan.legal) return failure(input, 'Execution requires a legal transition plan.');
  if (
    input.plan.sourceState === 'BLOCKED' ||
    input.plan.requestedTargetState === 'BLOCKED' ||
    input.plan.sourceState === 'COMPLETED' ||
    input.plan.requestedTargetState === 'COMPLETED'
  )
    return failure(input, 'TASK-008 cannot execute BLOCKED or COMPLETED transitions.');
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceHash))
    return failure(input, 'Expected source hash must be a lowercase SHA-256 digest.');
  const { handoff } = input;
  if (
    !oneLine(handoff.timestamp) ||
    !oneLine(handoff.evidence) ||
    !oneLine(handoff.nextAction) ||
    handoff.actor !== input.plan.sourceOwner ||
    handoff.recipient !== input.plan.targetOwner
  )
    return failure(input, 'Handoff evidence is incomplete or contradicts the planned owners.');

  const task = input.discovery.task;
  if (!['backlog', 'active', 'review'].includes(task.sourceStorage))
    return failure(input, 'Discovered task has an unsupported authoritative storage class.');
  const sourceDirectory = path.resolve(input.locations[task.sourceStorage]);
  const sourcePath = path.resolve(task.sourcePath);
  if (
    path.dirname(sourcePath) !== sourceDirectory ||
    path.extname(sourcePath).toLowerCase() !== '.md' ||
    path.basename(sourcePath).startsWith('.')
  )
    return failure(input, 'Discovered source path is outside its authoritative storage location.');
  if (!input.plan.destinationStorage || input.plan.destinationStorage === 'completed')
    return failure(input, 'Plan has no executable nonterminal destination.');
  const destinationPath = path.join(
    path.resolve(input.locations[input.plan.destinationStorage]),
    path.basename(sourcePath),
  );
  try {
    if (destinationPath !== sourcePath && (await exists(destinationPath, fileSystem)))
      return failure(input, 'Authoritative destination already exists.', null, destinationPath);
  } catch (error) {
    return failure(
      input,
      `Unable to inspect authoritative destination: ${String(error)}`,
      null,
      destinationPath,
    );
  }

  const freshDiscovery = await discoverActionableTask(task.owner, input.locations);
  if (
    freshDiscovery.outcome !== 'found' ||
    freshDiscovery.task.taskId !== task.taskId ||
    path.resolve(freshDiscovery.task.sourcePath) !== sourcePath
  )
    return failure(
      input,
      'Authoritative discovery changed or is no longer uniquely actionable.',
      null,
      destinationPath,
    );
  const freshPlan = planHandoffTransition({
    discovery: freshDiscovery,
    requestedTargetState: input.plan.requestedTargetState,
  });
  if (!freshPlan.legal || !samePlan(input.plan, freshPlan))
    return failure(
      input,
      'Transition plan is stale, contradictory, or no longer legal.',
      null,
      destinationPath,
    );

  let original: string;
  try {
    original = await fileSystem.readFile(sourcePath, 'utf8');
  } catch (error) {
    return failure(
      input,
      `Unable to read authoritative source: ${String(error)}`,
      null,
      destinationPath,
    );
  }
  const beforeHash = hash(original);
  if (beforeHash !== input.expectedSourceHash)
    return failure(
      input,
      'Authoritative source content hash changed before execution.',
      beforeHash,
      destinationPath,
    );
  let updated: string;
  try {
    updated = updateRecord(original, freshPlan, handoff);
  } catch (error) {
    return failure(
      input,
      `Authoritative record cannot be updated: ${String(error)}`,
      beforeHash,
      destinationPath,
    );
  }
  const afterHash = hash(updated);
  const nonce = randomUUID();
  const temporaryPath = path.join(sourceDirectory, `.${path.basename(sourcePath)}.${nonce}.new`);
  const backupPath = path.join(sourceDirectory, `.${path.basename(sourcePath)}.${nonce}.old`);
  let sourceBackedUp = false;
  let destinationInstalled = false;
  try {
    await fileSystem.writeFile(temporaryPath, updated, { encoding: 'utf8', flag: 'wx' });
    await fileSystem.rename(sourcePath, backupPath);
    sourceBackedUp = true;
    await fileSystem.rename(temporaryPath, destinationPath);
    destinationInstalled = true;
    await fileSystem.unlink(backupPath);
    return {
      taskId: task.taskId,
      sourceState: freshPlan.sourceState,
      targetState: freshPlan.requestedTargetState,
      sourceOwner: freshPlan.sourceOwner,
      targetOwner: freshPlan.targetOwner,
      sourcePath,
      destinationPath,
      beforeHash,
      afterHash,
      success: true,
      reason: 'Executed one guarded authoritative handoff.',
    };
  } catch (error) {
    try {
      if (destinationInstalled) await fileSystem.unlink(destinationPath);
      if (sourceBackedUp) await fileSystem.rename(backupPath, sourcePath);
      if (await exists(temporaryPath, fileSystem)) await fileSystem.unlink(temporaryPath);
    } catch (rollbackError) {
      return failure(
        input,
        `Atomic handoff failed and rollback failed: ${String(error)}; ${String(rollbackError)}`,
        beforeHash,
        destinationPath,
      );
    }
    return failure(
      input,
      `Atomic handoff failed; original restored: ${String(error)}`,
      beforeHash,
      destinationPath,
    );
  }
}
