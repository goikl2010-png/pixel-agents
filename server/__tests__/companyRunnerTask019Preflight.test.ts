import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  runShadowPilot,
  type ShadowPilotConfig,
} from '../../scripts/company-runner-shadow-pilot.js';
import {
  task019ConfigurationSha256,
  validateTask019PreflightConfig,
} from '../../scripts/company-runner-task-019-preflight.js';

const roots: string[] = [];
const configPath = path.resolve(
  __dirname,
  '../../config/company-runner-v1-task-019-preflight.json',
);
const approvalSchemaPath = path.resolve(
  __dirname,
  '../../docs/schemas/company-runner-approval-v1.schema.json',
);

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('checks in the exact inactive production preflight without a credential value', async () => {
  const config = validateTask019PreflightConfig(await readConfig());
  expect(config).toMatchObject({
    active: false,
    mode: 'run-once',
    task_id: 'TASK-020',
    target_state: 'READY_FOR_QA',
    target_owner: 'Pixel',
    max_dispatches: 1,
    dispatcher: 'codex',
    approval_policy: 'on-request',
    codex_version: 'codex-cli 0.150.1',
    workflow_mutation_adapter: false,
    credential_environment_variable: 'GH_TOKEN',
  });
  expect(JSON.stringify(config)).not.toMatch(/gh[opsu]_[A-Za-z0-9]|github_pat_/i);
});

it.each([
  ['active', true],
  ['mode', 'event'],
  ['task_id', 'TASK-019'],
  ['target_state', 'QA'],
  ['target_owner', 'Alex'],
  ['max_dispatches', 2],
  ['dispatcher', 'deterministic-fake'],
  ['approval_policy', 'never'],
  ['codex_version', 'codex-cli 0.149.0'],
  ['workflow_mutation_adapter', true],
  ['timeout_ms', 120_001],
] as const)('fails closed when %s drifts from the exact pilot', async (field, value) => {
  await expect(async () =>
    validateTask019PreflightConfig({ ...(await readConfig()), [field]: value }),
  ).rejects.toThrow();
});

it('fixes the exact direct Codex argument order and deterministic configuration hash', async () => {
  const config = validateTask019PreflightConfig(await readConfig());
  expect(config.argument_template.slice(0, 7)).toEqual([
    '--ask-for-approval',
    'on-request',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--cd',
  ]);
  expect(config.argument_template).not.toContain('--approve-for-me');
  expect(task019ConfigurationSha256(config)).toBe(
    '67031756b6b363802b6c6fe2af7c43c56744b4d91bb2b3bebd4ed2ca17622229',
  );
  expect(task019ConfigurationSha256(config)).toBe(task019ConfigurationSha256(await readConfig()));
});

it('produces one deterministic zero-external-mutation TASK-020 shadow decision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'task-019-shadow-'));
  roots.push(root);
  for (const directory of ['backlog', 'active', 'review', 'completed'])
    await mkdir(path.join(root, 'tasks', directory), { recursive: true });
  await mkdir(path.join(root, 'documentation', 'development'), { recursive: true });
  const head = '5b5357d3f6359d3df94ed5fe8371750fa34b25e3';
  await writeFile(
    path.join(root, 'documentation', 'development', 'evidence.md'),
    `Pixel evidence for ${head}\n`,
  );
  await writeFile(
    path.join(root, 'tasks', 'review', 'task.md'),
    `# TASK-020\n- **Task ID:** TASK-020\n- **Owner:** Pixel\n- **Current state:** READY_FOR_QA\n- **Resume state (required only when BLOCKED):** None\n- **Repository:** goikl2010-png/AI-Company\n- **GitHub Issue URL/number:** Issue #3\n- **Pull Request URL/number:** PR #4\n- **Base branch:** main\n- **Feature branch:** task/TASK-020-reconcile-company-runner-roadmap\n- **Current PR head commit:** ${head}\n- **Evidence link:** \`documentation/development/evidence.md\`\n`,
  );
  const shadowConfig: ShadowPilotConfig = {
    schema_version: '1',
    active: false,
    mode: 'run-once',
    task_id: 'TASK-020',
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
  const facts = {
    repository: 'goikl2010-png/AI-Company',
    issue: 3,
    issueState: 'OPEN' as const,
    pr: 4,
    prState: 'OPEN' as const,
    draft: true,
    base: 'main',
    branch: 'task/TASK-020-reconcile-company-runner-roadmap',
    head,
  };
  const first = await runShadowPilot({
    config: shadowConfig,
    fixtureRoot: root,
    githubFacts: facts,
    approvalSchemaPath,
  });
  const second = await runShadowPilot({
    config: shadowConfig,
    fixtureRoot: root,
    githubFacts: facts,
    approvalSchemaPath,
  });
  expect(first).toMatchObject({
    outcome: 'DISPATCHED',
    source_fixture_unchanged: true,
    dispatch_count: 1,
    external_mutations: 0,
  });
  expect(first.decision).toMatchObject({
    task_id: 'TASK-020',
    state: 'READY_FOR_QA',
    owner: 'Pixel',
    action_kind: 'DISPATCH_ROLE',
  });
  expect(second.decision).toEqual(first.decision);
});
