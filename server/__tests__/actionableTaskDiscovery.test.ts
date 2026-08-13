import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  discoverActionableTask,
  type EmployeeIdentity,
  type TaskLocations,
} from '../src/actionableTaskDiscovery.js';

const roots: string[] = [];
async function fixture(): Promise<TaskLocations> {
  const root = await mkdtemp(path.join(tmpdir(), 'pixel-agents-tasks-'));
  roots.push(root);
  const locations = {
    backlog: path.join(root, 'custom-backlog'),
    active: path.join(root, 'custom-active'),
    review: path.join(root, 'custom-review'),
  };
  await Promise.all(Object.values(locations).map((directory) => mkdir(directory)));
  return locations;
}
function record(id: string, owner: string, state: string, resume = 'None'): string {
  return `# ${id}\n\n- **Task ID:** ${id}\n- **Owner:** ${owner}\n- **Current state:** ${state}\n- **Resume state (required only when BLOCKED):** ${resume}\n`;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each<[EmployeeIdentity, string]>([
  ['Alex', 'BACKLOG'],
  ['Nova', 'DEVELOPMENT'],
  ['Pixel', 'QA_RETEST'],
  ['Atlas', 'REVIEW'],
])('finds canonical %s task from saved fields', async (employee, state) => {
  const locations = await fixture();
  await writeFile(
    path.join(locations.review, `${employee}.md`),
    record(`TASK-${employee}`, employee, state),
  );
  await expect(discoverActionableTask(employee, locations)).resolves.toMatchObject({
    outcome: 'found',
    task: { taskId: `TASK-${employee}`, owner: employee, currentState: state },
  });
});
it('ignores other owners, completed tasks, and directory placement', async () => {
  const locations = await fixture();
  await writeFile(path.join(locations.active, 'other.md'), record('TASK-1', 'Pixel', 'QA'));
  await writeFile(path.join(locations.backlog, 'done.md'), record('TASK-2', 'Alex', 'COMPLETED'));
  await expect(discoverActionableTask('Nova', locations)).resolves.toEqual({
    outcome: 'none',
    employee: 'Nova',
  });
});
it('reports deterministic multiple-match conflicts', async () => {
  const locations = await fixture();
  await writeFile(path.join(locations.active, 'z.md'), record('TASK-9', 'Nova', 'DEVELOPMENT'));
  await writeFile(
    path.join(locations.review, 'a.md'),
    record('TASK-1', 'Nova', 'CHANGES_REQUIRED'),
  );
  const result = await discoverActionableTask('Nova', locations);
  expect(result.outcome).toBe('conflict');
  if (result.outcome === 'conflict')
    expect(result.tasks.map((task) => task.taskId)).toEqual(['TASK-1', 'TASK-9']);
});
it.each([
  [record('TASK-1', 'Nova', 'DEVELOPMENT'), record('TASK-1', 'Alex', 'COMPLETED')],
  [record('TASK-1', 'Nova', 'CHANGES_REQUIRED'), record('TASK-1', 'Pixel', 'QA')],
  [record('TASK-1', 'Nova', 'DEVELOPMENT'), record('TASK-1', 'Nova', 'DEVELOPMENT')],
])('rejects duplicate Task IDs across authoritative files', async (first, second) => {
  const locations = await fixture();
  await writeFile(path.join(locations.active, 'first.md'), first);
  await writeFile(path.join(locations.review, 'second.md'), second);
  await expect(discoverActionableTask('Nova', locations)).resolves.toMatchObject({
    outcome: 'error',
    errors: [expect.stringContaining('duplicate Task ID "TASK-1"')],
  });
});
it.each([
  ['Task ID', 'TASK-1'],
  ['Owner', 'Nova'],
  ['Owner', 'Alex'],
  ['Current state', 'DEVELOPMENT'],
  ['Current state', 'CHANGES_REQUIRED'],
  ['Resume state (required only when BLOCKED)', 'None'],
  ['Resume state (required only when BLOCKED)', 'QA'],
])('rejects duplicate %s fields with matching or contradictory values', async (name, value) => {
  const locations = await fixture();
  const markdown = `${record('TASK-1', 'Nova', 'DEVELOPMENT')}- **${name}:** ${value}\n`;
  await writeFile(path.join(locations.active, 'duplicate-field.md'), markdown);
  await expect(discoverActionableTask('Nova', locations)).resolves.toMatchObject({
    outcome: 'error',
    errors: [expect.stringContaining(`duplicate ${name} fields`)],
  });
});
it.each([
  record('TASK-1', 'Nova', 'QA'),
  record('TASK-1', 'Alex', 'BLOCKED'),
  record('TASK-1', 'Alex', 'BLOCKED', 'COMPLETED'),
  record('TASK-1', 'Nova', 'DEVELOPMENT', 'QA'),
  '# TASK-1\n- **Owner:** Nova\n',
])('reports malformed or contradictory records', async (markdown) => {
  const locations = await fixture();
  await writeFile(path.join(locations.active, 'bad.md'), markdown);
  await expect(discoverActionableTask('Nova', locations)).resolves.toMatchObject({
    outcome: 'error',
  });
});
it('accepts Alex BLOCKED with valid resume metadata', async () => {
  const locations = await fixture();
  await writeFile(
    path.join(locations.active, 'blocked.md'),
    record('TASK-1', 'Alex', 'BLOCKED', 'DEVELOPMENT'),
  );
  await expect(discoverActionableTask('Alex', locations)).resolves.toMatchObject({
    outcome: 'found',
    task: { currentState: 'BLOCKED', resumeState: 'DEVELOPMENT' },
  });
});
it('uses configured locations without mutation', async () => {
  const locations = await fixture();
  const file = path.join(locations.active, 'task.md');
  const before = record('TASK-1', 'Nova', 'DEVELOPMENT');
  await writeFile(file, before);
  await discoverActionableTask('Nova', locations);
  expect(await readFile(file, 'utf8')).toBe(before);
});
