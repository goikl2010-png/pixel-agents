import { createHash } from 'crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  discoverActionableTask,
  type EmployeeIdentity,
  type TaskLocations,
} from '../src/actionableTaskDiscovery.js';
import {
  executeHandoff,
  type HandoffExecutionInput,
  type HandoffFileSystem,
} from '../src/handoffExecutor.js';
import { type LifecycleState, planHandoffTransition } from '../src/handoffTransitionPlanner.js';

const roots: string[] = [];
const owners: Record<LifecycleState, EmployeeIdentity> = {
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
const sourceStorage: Partial<Record<LifecycleState, keyof TaskLocations>> = {
  BACKLOG: 'backlog',
  DEVELOPMENT: 'active',
  CHANGES_REQUIRED: 'active',
  READY_FOR_QA: 'review',
  QA: 'review',
  QA_RETEST: 'review',
  READY_FOR_REVIEW: 'review',
  REVIEW: 'review',
  APPROVED: 'review',
  BLOCKED: 'review',
};
const transitions: Array<[LifecycleState, LifecycleState, keyof TaskLocations]> = [
  ['BACKLOG', 'DEVELOPMENT', 'active'],
  ['DEVELOPMENT', 'READY_FOR_QA', 'review'],
  ['READY_FOR_QA', 'QA', 'review'],
  ['QA', 'READY_FOR_REVIEW', 'review'],
  ['QA', 'CHANGES_REQUIRED', 'active'],
  ['CHANGES_REQUIRED', 'QA_RETEST', 'review'],
  ['QA_RETEST', 'READY_FOR_REVIEW', 'review'],
  ['QA_RETEST', 'CHANGES_REQUIRED', 'active'],
  ['READY_FOR_REVIEW', 'REVIEW', 'review'],
  ['REVIEW', 'APPROVED', 'review'],
  ['REVIEW', 'CHANGES_REQUIRED', 'active'],
];

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function record(state: LifecycleState, owner = owners[state]): string {
  return `# TASK-008: Fixture

- **Task ID:** TASK-008
- **Project:** Fixture
- **Title:** Fixture
- **Owner:** ${owner}
- **Current state:** ${state}
- **Previous state:** BACKLOG
- **Resume state (required only when BLOCKED):** ${state === 'BLOCKED' ? 'QA' : 'None'}

## Objective

Keep this byte-identical outside required fields.

## Handoff History

| Date/time | From | To | State transition | Evidence verified or supplied | Next required action |
| --- | --- | --- | --- | --- | --- |
| prior | Alex | Nova | prior | old evidence | old action |

## Final Closure Record

- **Closed by:** Pending
`;
}

async function fixture(
  source: LifecycleState,
  target: LifecycleState,
): Promise<{
  input: HandoffExecutionInput;
  locations: TaskLocations;
  sourcePath: string;
  original: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'handoff-executor-'));
  roots.push(root);
  const locations = {
    backlog: path.join(root, 'backlog'),
    active: path.join(root, 'active'),
    review: path.join(root, 'review'),
  };
  await Promise.all(Object.values(locations).map((directory) => mkdir(directory)));
  const original = record(source);
  const sourcePath = path.join(locations[sourceStorage[source]!], 'task.md');
  await writeFile(sourcePath, original);
  const discovery = await discoverActionableTask(owners[source], locations);
  const plan = planHandoffTransition({ discovery, requestedTargetState: target });
  return {
    locations,
    sourcePath,
    original,
    input: {
      discovery,
      plan,
      locations,
      expectedSourceHash: digest(original),
      handoff: {
        actor: owners[source],
        recipient: owners[target],
        timestamp: '2026-08-14 14:00 +08:00',
        evidence: 'verified evidence',
        nextAction: 'perform next gate',
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(transitions)('executes guarded %s -> %s into %s', async (source, target, destination) => {
  const { input, locations, sourcePath, original } = await fixture(source, target);
  const result = await executeHandoff(input);
  const destinationPath = path.join(locations[destination], 'task.md');
  expect(result).toMatchObject({
    success: true,
    taskId: 'TASK-008',
    sourceState: source,
    targetState: target,
    sourceOwner: owners[source],
    targetOwner: owners[target],
    sourcePath,
    destinationPath,
    beforeHash: digest(original),
  });
  const updated = await readFile(destinationPath, 'utf8');
  expect(result.afterHash).toBe(digest(updated));
  expect(updated).toContain(`- **Previous state:** ${source}`);
  expect(updated).toContain(`- **Current state:** ${target}`);
  expect(updated).toContain(`- **Owner:** ${owners[target]}`);
  expect(updated).toContain('- **Resume state (required only when BLOCKED):** None');
  expect(updated).toContain('| 2026-08-14 14:00 +08:00 |');
  expect(updated.match(/verified evidence/g)).toHaveLength(1);
  expect(updated).toContain('Keep this byte-identical outside required fields.');
  if (destinationPath !== sourcePath)
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (await readdir(path.dirname(sourcePath))).filter((name) => name.startsWith('.task.md')),
  ).toEqual([]);
});

it('preserves every unrelated task byte-for-byte', async () => {
  const { input, locations } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const other = path.join(locations.backlog, 'other.md');
  await writeFile(other, record('BACKLOG').replaceAll('TASK-008', 'TASK-OTHER'));
  const before = await readFile(other, 'utf8');
  expect((await executeHandoff(input)).success).toBe(true);
  expect(await readFile(other, 'utf8')).toBe(before);
});

it.each([
  [
    'stale hash',
    (input: HandoffExecutionInput) => {
      input.expectedSourceHash = '0'.repeat(64);
    },
  ],
  [
    'actor contradiction',
    (input: HandoffExecutionInput) => {
      input.handoff.actor = 'Alex';
    },
  ],
  [
    'recipient contradiction',
    (input: HandoffExecutionInput) => {
      input.handoff.recipient = 'Atlas';
    },
  ],
  [
    'blank evidence',
    (input: HandoffExecutionInput) => {
      input.handoff.evidence = ' ';
    },
  ],
  [
    'multiline evidence',
    (input: HandoffExecutionInput) => {
      input.handoff.evidence = 'a\nb';
    },
  ],
  [
    'illegal plan',
    (input: HandoffExecutionInput) => {
      input.plan.legal = false;
    },
  ],
  [
    'unexpected path',
    (input: HandoffExecutionInput) => {
      if (input.discovery.outcome === 'found') input.discovery.task.sourcePath += '.outside';
    },
  ],
] as const)('fails closed for %s', async (_name, alter) => {
  const { input, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  alter(input);
  expect((await executeHandoff(input)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
});

it('fails closed for a destination collision', async () => {
  const { input, locations, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const collision = path.join(locations.review, 'task.md');
  await writeFile(collision, 'collision');
  expect((await executeHandoff(input)).reason).toContain('destination already exists');
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
  expect(await readFile(collision, 'utf8')).toBe('collision');
});

it('fails closed when duplicate task IDs invalidate re-discovery', async () => {
  const { input, locations, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  await writeFile(path.join(locations.review, 'duplicate.md'), original);
  expect((await executeHandoff(input)).reason).toContain('discovery changed');
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
});

it.each([
  [
    'changed state and owner',
    (content: string) =>
      content
        .replace('**Owner:** Nova', '**Owner:** Pixel')
        .replace('**Current state:** DEVELOPMENT', '**Current state:** QA'),
  ],
  [
    'malformed record',
    (content: string) => content.replace('- **Current state:** DEVELOPMENT\n', ''),
  ],
] as const)('fails closed when revalidation sees a %s', async (_name, alter) => {
  const { input, sourcePath } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const changed = alter(await readFile(sourcePath, 'utf8'));
  await writeFile(sourcePath, changed);
  expect((await executeHandoff(input)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(changed);
});

it('fails closed for a non-found initial discovery result', async () => {
  const { input, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  input.discovery = { outcome: 'none', employee: 'Nova' };
  expect((await executeHandoff(input)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
});

it.each(['BLOCKED', 'COMPLETED'] as const)('refuses transitions targeting %s', async (target) => {
  const { input, sourcePath, original } = await fixture('APPROVED', 'COMPLETED');
  input.plan.requestedTargetState = target;
  input.plan.legal = true;
  expect((await executeHandoff(input)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
});

it.each(['write', 'move'] as const)(
  'restores the original and cleans artifacts on injected %s failure',
  async (failurePoint) => {
    const { input, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
    const native = await import('fs/promises');
    const injected: HandoffFileSystem = {
      readFile: (file, encoding) => native.readFile(file, encoding),
      writeFile: async (file, content, options) => {
        if (failurePoint === 'write') throw new Error('injected write failure');
        await native.writeFile(file, content, options);
      },
      rename: (from, to) => native.rename(from, to),
      link: async (from, to) => {
        if (failurePoint === 'move') throw new Error('injected move failure');
        await native.link(from, to);
      },
      unlink: (file) => native.unlink(file),
      stat: (file) => native.stat(file),
    };
    expect((await executeHandoff(input, injected)).success).toBe(false);
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    expect(
      (await readdir(path.dirname(sourcePath))).filter((name) => name.startsWith('.task.md')),
    ).toEqual([]);
  },
);

it('preserves a concurrent edit injected immediately before the atomic source claim', async () => {
  const { input, locations, sourcePath } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const concurrent = record('DEVELOPMENT').replace(
    'Keep this byte-identical outside required fields.',
    'Concurrent authoritative edit.',
  );
  const native = await import('fs/promises');
  let claimed = false;
  const injected: HandoffFileSystem = {
    readFile: (file, encoding) => native.readFile(file, encoding),
    writeFile: (file, content, options) => native.writeFile(file, content, options),
    rename: async (from, to) => {
      if (!claimed && from === sourcePath) {
        claimed = true;
        await native.writeFile(sourcePath, concurrent);
      }
      await native.rename(from, to);
    },
    link: (from, to) => native.link(from, to),
    unlink: (file) => native.unlink(file),
    stat: (file) => native.stat(file),
  };
  const result = await executeHandoff(input, injected);
  expect(result).toMatchObject({ success: false, beforeHash: digest(concurrent) });
  expect(await readFile(sourcePath, 'utf8')).toBe(concurrent);
  await expect(stat(path.join(locations.review, 'task.md'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    (await readdir(path.dirname(sourcePath))).filter((name) => name.startsWith('.task.md')),
  ).toEqual([]);
});

it('preserves post-check destination contention without overwriting either record', async () => {
  const { input, locations, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const destinationPath = path.join(locations.review, 'task.md');
  const native = await import('fs/promises');
  const injected: HandoffFileSystem = {
    readFile: (file, encoding) => native.readFile(file, encoding),
    writeFile: (file, content, options) => native.writeFile(file, content, options),
    rename: (from, to) => native.rename(from, to),
    link: async (from, to) => {
      await native.writeFile(to, 'concurrent destination');
      await native.link(from, to);
    },
    unlink: (file) => native.unlink(file),
    stat: (file) => native.stat(file),
  };
  expect((await executeHandoff(input, injected)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
  expect(await readFile(destinationPath, 'utf8')).toBe('concurrent destination');
  expect(
    (await readdir(path.dirname(sourcePath))).filter((name) => name.startsWith('.task.md')),
  ).toEqual([]);
});

it('retries a transient rollback rename failure without losing the authoritative record', async () => {
  const { input, sourcePath, original } = await fixture('DEVELOPMENT', 'READY_FOR_QA');
  const native = await import('fs/promises');
  let rollbackFailures = 0;
  const injected: HandoffFileSystem = {
    readFile: (file, encoding) => native.readFile(file, encoding),
    writeFile: (file, content, options) => native.writeFile(file, content, options),
    rename: async (from, to) => {
      if (to === sourcePath && rollbackFailures++ === 0)
        throw new Error('transient rollback failure');
      await native.rename(from, to);
    },
    link: async () => {
      throw new Error('force rollback');
    },
    unlink: (file) => native.unlink(file),
    stat: (file) => native.stat(file),
  };
  expect((await executeHandoff(input, injected)).success).toBe(false);
  expect(await readFile(sourcePath, 'utf8')).toBe(original);
  expect(
    (await readdir(path.dirname(sourcePath))).filter((name) => name.startsWith('.task.md')),
  ).toEqual([]);
});
