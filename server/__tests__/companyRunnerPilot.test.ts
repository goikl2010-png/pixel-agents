import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  runShadowPilot,
  type ShadowPilotConfig,
  validateShadowPilotConfig,
} from '../../scripts/company-runner-shadow-pilot.js';

const roots: string[] = [];
const approvalSchemaPath = path.resolve(
  __dirname,
  '../../docs/schemas/company-runner-approval-v1.schema.json',
);
const facts = {
  repository: 'owner/repo',
  issue: 26,
  issueState: 'OPEN' as const,
  pr: 27,
  prState: 'OPEN' as const,
  draft: true,
  base: 'main',
  branch: 'task/TASK-018-company-runner-controlled-pilot',
  head: 'a'.repeat(40),
};
const config: ShadowPilotConfig = {
  schema_version: '1',
  active: false,
  mode: 'run-once',
  task_id: 'TASK-018',
  max_dispatches: 1,
  dispatcher: 'deterministic-fake',
  approval_policy: 'on-request',
  company_root: '<disposable-fixture>',
  state_directory: '<disposable-state>',
  stop_file: '<disposable-stop>',
  timeout_ms: 120_000,
  lease_ttl_ms: 30_000,
  heartbeat_ms: 10_000,
  circuit_failure_threshold: 3,
  workflow_mutation_adapter: false,
  credential_environment_variable: 'GH_TOKEN',
};

async function fixture(state = 'DEVELOPMENT', owner = 'Nova'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'company-runner-pilot-fixture-'));
  roots.push(root);
  for (const directory of ['backlog', 'active', 'review', 'completed'])
    await mkdir(path.join(root, 'tasks', directory), { recursive: true });
  await mkdir(path.join(root, 'documentation', 'development'), { recursive: true });
  await writeFile(
    path.join(root, 'documentation', 'development', 'evidence.md'),
    `Nova evidence for ${facts.head}\n`,
  );
  const storage = state === 'COMPLETED' ? 'completed' : 'active';
  await writeFile(
    path.join(root, 'tasks', storage, 'task.md'),
    `# TASK-018\n- **Task ID:** TASK-018\n- **Owner:** ${owner}\n- **Current state:** ${state}\n- **Resume state (required only when BLOCKED):** None\n- **Repository:** owner/repo\n- **GitHub Issue URL/number:** Issue #26\n- **Pull Request URL/number:** PR #27\n- **Base branch:** main\n- **Feature branch:** ${facts.branch}\n- **Current PR head commit:** ${facts.head}\n- **Evidence link:** \`documentation/development/evidence.md\`\n`,
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('checks in an inactive, credential-free, one-task/run-once example', async () => {
  const example = JSON.parse(
    await readFile(path.resolve(__dirname, '../../config/company-runner-v1.example.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(example).toMatchObject({
    active: false,
    mode: 'run-once',
    max_dispatches: 1,
    dispatcher: 'deterministic-fake',
    approval_policy: 'on-request',
    workflow_mutation_adapter: false,
  });
  expect(Object.keys(example)).not.toContain('credential');
  expect(JSON.stringify(example)).not.toMatch(/password|secret/i);
});

it.each([
  ['active', true],
  ['mode', 'event'],
  ['max_dispatches', 2],
  ['dispatcher', 'codex'],
  ['approval_policy', 'never'],
  ['workflow_mutation_adapter', true],
  ['timeout_ms', 120_001],
  ['lease_ttl_ms', 30_001],
  ['heartbeat_ms', 30_000],
  ['circuit_failure_threshold', 4],
] as const)('fails closed when %s violates the controlled-pilot boundary', (field, value) => {
  expect(() => validateShadowPilotConfig({ ...config, [field]: value })).toThrow();
});

it('runs exactly one deterministic fake dispatch in a disposable shadow and emits evidence', async () => {
  const root = await fixture();
  const first = await runShadowPilot({
    config,
    fixtureRoot: root,
    githubFacts: facts,
    approvalSchemaPath,
  });
  const second = await runShadowPilot({
    config,
    fixtureRoot: root,
    githubFacts: facts,
    approvalSchemaPath,
  });
  expect(first).toMatchObject({
    outcome: 'DISPATCHED',
    source_fixture_unchanged: true,
    dispatch_count: 1,
    external_mutations: 0,
    status: {
      task: 'TASK-018',
      state: 'DEVELOPMENT',
      owner: 'Nova',
      dispatch_count: 1,
      lease: { status: 'free' },
      circuit: 'closed',
      model: 'fake',
      input_tokens: 0,
      output_tokens: 0,
    },
  });
  expect(first.fixture_sha256_before).toBe(first.fixture_sha256_after);
  expect(first.decision).toMatchObject({
    task_id: 'TASK-018',
    state: 'DEVELOPMENT',
    owner: 'Nova',
    action_kind: 'DISPATCH_ROLE',
    classification: 'GREEN',
    state_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    dispatch_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
  expect(second.decision).toEqual(first.decision);
  expect(first.handoff).toMatchObject({ role: 'Nova', state: 'DEVELOPMENT' });
});

it('refuses terminal, malformed, duplicate, and conflicted fixtures', async () => {
  const terminal = await fixture('COMPLETED', 'Alex');
  await expect(
    runShadowPilot({ config, fixtureRoot: terminal, githubFacts: facts, approvalSchemaPath }),
  ).resolves.toMatchObject({
    outcome: 'NO_ACTION_TERMINAL',
    dispatch_count: 0,
    external_mutations: 0,
  });
  const blocked = await fixture('BLOCKED', 'Alex');
  await expect(
    runShadowPilot({ config, fixtureRoot: blocked, githubFacts: facts, approvalSchemaPath }),
  ).rejects.toThrow();
  const duplicate = await fixture();
  await writeFile(
    path.join(duplicate, 'tasks', 'review', 'duplicate.md'),
    await readFile(path.join(duplicate, 'tasks', 'active', 'task.md'), 'utf8'),
  );
  await expect(
    runShadowPilot({ config, fixtureRoot: duplicate, githubFacts: facts, approvalSchemaPath }),
  ).rejects.toThrow('exactly one');
  const conflict = await fixture();
  await expect(
    runShadowPilot({
      config,
      fixtureRoot: conflict,
      githubFacts: { ...facts, head: 'b'.repeat(40) },
      approvalSchemaPath,
    }),
  ).rejects.toThrow('conflicts');
});
