import { promises as fs } from 'fs';
import * as path from 'path';

export const EMPLOYEE_IDENTITIES = ['Alex', 'Nova', 'Pixel', 'Atlas'] as const;
export type EmployeeIdentity = (typeof EMPLOYEE_IDENTITIES)[number];

const ACTIONABLE_STATES: Readonly<Record<EmployeeIdentity, readonly string[]>> = {
  Alex: ['BACKLOG', 'APPROVED', 'BLOCKED'],
  Nova: ['DEVELOPMENT', 'CHANGES_REQUIRED'],
  Pixel: ['READY_FOR_QA', 'QA', 'QA_RETEST'],
  Atlas: ['READY_FOR_REVIEW', 'REVIEW'],
};
const STATE_OWNER = new Map<string, EmployeeIdentity>(
  Object.entries(ACTIONABLE_STATES).flatMap(([owner, states]) =>
    states.map((state) => [state, owner as EmployeeIdentity]),
  ),
);
STATE_OWNER.set('COMPLETED', 'Alex');
const RESUME_STATES = new Set([...STATE_OWNER.keys()].filter((state) => state !== 'COMPLETED'));

export interface TaskLocations {
  backlog: string;
  active: string;
  review: string;
}
export interface ActionableTask {
  taskId: string;
  owner: EmployeeIdentity;
  currentState: string;
  resumeState?: string;
  sourcePath: string;
}
export type TaskDiscoveryResult =
  | { outcome: 'found'; task: ActionableTask }
  | { outcome: 'none'; employee: EmployeeIdentity }
  | { outcome: 'conflict'; employee: EmployeeIdentity; tasks: ActionableTask[] }
  | { outcome: 'error'; employee: EmployeeIdentity; errors: string[] };

function field(markdown: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(
    new RegExp(`^\\s*-?\\s*\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, 'im'),
  );
  if (!match) return undefined;
  const value = match[1].trim().replace(/^`|`$/g, '');
  return value === 'None' ? undefined : value;
}

function parseTask(markdown: string, sourcePath: string): ActionableTask | string {
  const taskId = field(markdown, 'Task ID');
  const owner = field(markdown, 'Owner');
  const currentState = field(markdown, 'Current state');
  const resumeState = field(markdown, 'Resume state (required only when BLOCKED)');
  if (!taskId || !owner || !currentState)
    return `${sourcePath}: missing Task ID, Owner, or Current state`;
  if (!EMPLOYEE_IDENTITIES.includes(owner as EmployeeIdentity))
    return `${sourcePath}: unsupported Owner ${JSON.stringify(owner)}`;
  const expectedOwner = STATE_OWNER.get(currentState);
  if (!expectedOwner)
    return `${sourcePath}: unsupported Current state ${JSON.stringify(currentState)}`;
  if (owner !== expectedOwner)
    return `${sourcePath}: Current state ${currentState} must be owned by ${expectedOwner}, not ${owner}`;
  if (currentState === 'BLOCKED' && (!resumeState || !RESUME_STATES.has(resumeState)))
    return `${sourcePath}: BLOCKED requires a valid nonterminal Resume state`;
  if (currentState !== 'BLOCKED' && resumeState)
    return `${sourcePath}: Resume state is only valid when Current state is BLOCKED`;
  return {
    taskId,
    owner: owner as EmployeeIdentity,
    currentState,
    ...(resumeState ? { resumeState } : {}),
    sourcePath,
  };
}

export async function discoverActionableTask(
  employee: EmployeeIdentity,
  locations: TaskLocations,
): Promise<TaskDiscoveryResult> {
  const errors: string[] = [];
  const tasks: ActionableTask[] = [];
  const files: string[] = [];
  for (const directory of [locations.backlog, locations.active, locations.review]) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      files.push(
        ...entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
          .map((entry) => path.join(directory, entry.name)),
      );
    } catch (error) {
      errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const sourcePath of files.sort((a, b) => a.localeCompare(b))) {
    try {
      const parsed = parseTask(await fs.readFile(sourcePath, 'utf8'), sourcePath);
      if (typeof parsed === 'string') errors.push(parsed);
      else tasks.push(parsed);
    } catch (error) {
      errors.push(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) return { outcome: 'error', employee, errors: errors.sort() };
  const matches = tasks
    .filter(
      (task) => task.owner === employee && ACTIONABLE_STATES[employee].includes(task.currentState),
    )
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.sourcePath.localeCompare(b.sourcePath));
  if (matches.length === 0) return { outcome: 'none', employee };
  if (matches.length === 1) return { outcome: 'found', task: matches[0] };
  return { outcome: 'conflict', employee, tasks: matches };
}
