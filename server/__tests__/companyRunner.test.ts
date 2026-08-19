import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  buildGovernedChildEnvironment,
  CodexAgentDispatcher,
  decideRunnerAction,
  FakeAgentDispatcher,
  readRunnerTask,
  runCompanyOnce,
  RunnerLedger,
  runnerStatus,
} from '../src/companyRunner.js';
import { LIFECYCLE_STATES, storageForLifecycleState } from '../src/handoffTransitionPlanner.js';

const roots: string[] = [];
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
async function fixture(state = 'DEVELOPMENT', owner: string = 'Nova', resume = 'None') {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-v1-'));
  roots.push(root);
  await Promise.all(
    ['backlog', 'active', 'review', 'completed'].map((name) =>
      mkdir(path.join(root, 'tasks', name), { recursive: true }),
    ),
  );
  const storage =
    state === 'BLOCKED' ? 'active' : storageForLifecycleState(state as keyof typeof owners)!;
  const task = path.join(root, 'tasks', storage, 'task.md');
  await writeFile(
    task,
    `# TASK-016\n- **Task ID:** TASK-016\n- **Owner:** ${owner}\n- **Current state:** ${state}\n- **Resume state (required only when BLOCKED):** ${resume}\n- **Evidence link:** \`documentation/qa/report.md\`\n`,
  );
  return { root, task, stateDir: path.join(root, '.runner') };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(LIFECYCLE_STATES)('routes canonical state %s only to its owner', async (state) => {
  const { root } = await fixture(state, owners[state], state === 'BLOCKED' ? 'QA' : 'None');
  const decision = decideRunnerAction(await readRunnerTask(root, 'TASK-016'));
  expect(decision.owner).toBe(owners[state]);
  expect(decision.action_kind).toBe(
    state === 'COMPLETED'
      ? 'STOP_TERMINAL'
      : ['APPROVED', 'BLOCKED'].includes(state)
        ? 'AWAIT_ALEX_DECISION'
        : 'DISPATCH_ROLE',
  );
});

it.each([
  ['FAILED', 'Pixel', 'None'],
  ['DEVELOPMENT', 'Pixel', 'None'],
  ['BLOCKED', 'Alex', 'None'],
  ['DEVELOPMENT', 'Nova', 'QA'],
])('fails closed for malformed state/owner/resume %s', async (state, owner, resume) => {
  const { root } = await fixture(state, owner, resume);
  await expect(readRunnerTask(root, 'TASK-016')).rejects.toThrow();
});

it('requires exactly one explicit authoritative record', async () => {
  const { root, task } = await fixture();
  await writeFile(path.join(root, 'tasks', 'review', 'duplicate.md'), await readFile(task, 'utf8'));
  await expect(readRunnerTask(root, 'TASK-016')).rejects.toThrow('exactly one');
  await expect(readRunnerTask(root, 'TASK-999')).rejects.toThrow('found 0');
});

it('is deterministic and dry-run invokes no agent', async () => {
  const { root, stateDir } = await fixture();
  const task = await readRunnerTask(root, 'TASK-016');
  expect(JSON.stringify(decideRunnerAction(task))).toBe(JSON.stringify(decideRunnerAction(task)));
  const fake = new FakeAgentDispatcher();
  const result = await runCompanyOnce({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher: fake,
    dryRun: true,
  });
  expect(result.outcome).toBe('DRY_RUN');
  expect(fake.calls).toHaveLength(0);
});

it('dispatches once and unchanged restart invokes no agent', async () => {
  const { root, stateDir } = await fixture();
  const first = new FakeAgentDispatcher();
  expect(
    (
      await runCompanyOnce({
        companyRoot: root,
        taskId: 'TASK-016',
        stateDirectory: stateDir,
        dispatcher: first,
      })
    ).outcome,
  ).toBe('DISPATCHED');
  const second = new FakeAgentDispatcher();
  expect(
    (
      await runCompanyOnce({
        companyRoot: root,
        taskId: 'TASK-016',
        stateDirectory: stateDir,
        dispatcher: second,
      })
    ).outcome,
  ).toBe('NO_ACTION_UNCHANGED');
  expect(first.calls).toHaveLength(1);
  expect(second.calls).toHaveLength(0);
  await expect(runnerStatus(root, 'TASK-016', stateDir)).resolves.toMatchObject({
    dispatch_count: 1,
    lease: 'free',
    model: 'fake',
  });
});

it.each([
  ['COMPLETED', 'Alex', 'NO_ACTION_TERMINAL'],
  ['APPROVED', 'Alex', 'APPROVAL_REQUIRED'],
  ['BLOCKED', 'Alex', 'APPROVAL_REQUIRED'],
] as const)('stops without dispatch for %s', async (state, owner, outcome) => {
  const { root, stateDir } = await fixture(
    state,
    owner,
    state === 'BLOCKED' ? 'DEVELOPMENT' : 'None',
  );
  const fake = new FakeAgentDispatcher();
  expect(
    (
      await runCompanyOnce({
        companyRoot: root,
        taskId: 'TASK-016',
        stateDirectory: stateDir,
        dispatcher: fake,
      })
    ).outcome,
  ).toBe(outcome);
  expect(fake.calls).toHaveLength(0);
});

it('detects ledger tampering', async () => {
  const { root, stateDir } = await fixture();
  await runCompanyOnce({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher: new FakeAgentDispatcher(),
    dryRun: true,
  });
  const file = path.join(stateDir, 'TASK-016.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')).replace('DRY_RUN', 'ALTERED'));
  await expect(new RunnerLedger(file).read()).rejects.toThrow('integrity');
});

it('rejects Codex substitution and version drift before launch', async () => {
  const packet = {
    schema_version: '1' as const,
    task: { id: 'TASK-016', path: 'x', fingerprint: 'sha256:x' },
    role: 'Nova' as const,
    state: 'DEVELOPMENT' as const,
    dispatch_id: 'sha256:x',
    evidence: [],
    instruction: 'safe',
  };
  await expect(
    new CodexAgentDispatcher({
      executable: 'other',
      allowedExecutable: 'codex',
      workingRoot: path.resolve('.'),
      timeoutMs: 10,
      credentialEnvironmentVariable: 'GH_TOKEN',
      parentEnvironment: { GH_TOKEN: 'fake-sentinel' },
      versionProbe: async () => 'codex-cli 0.148.0',
    }).dispatch(packet, new AbortController().signal),
  ).rejects.toThrow('allowlisted');
  await expect(
    new CodexAgentDispatcher({
      executable: 'codex',
      allowedExecutable: 'codex',
      workingRoot: path.resolve('.'),
      timeoutMs: 10,
      credentialEnvironmentVariable: 'GH_TOKEN',
      parentEnvironment: { GH_TOKEN: 'fake-sentinel' },
      versionProbe: async () => 'codex-cli 0.1.0',
    }).dispatch(packet, new AbortController().signal),
  ).rejects.toThrow('Unsupported');
});

it('inherits one fake credential, process-scoped OpenSSL, and no unrelated secrets', () => {
  const environment = buildGovernedChildEnvironment(
    {
      GH_TOKEN: 'fake-sentinel-gh-token',
      PATH: 'safe-path',
      AWS_SECRET_ACCESS_KEY: 'must-not-pass',
      RANDOM_PRIVATE_TOKEN: 'must-not-pass',
    },
    'GH_TOKEN',
  );
  expect(environment).toMatchObject({
    GH_TOKEN: 'fake-sentinel-gh-token',
    PATH: 'safe-path',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.sslBackend',
    GIT_CONFIG_VALUE_0: 'openssl',
  });
  expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(environment.RANDOM_PRIVATE_TOKEN).toBeUndefined();
  expect(environment.GIT_SSL_NO_VERIFY).toBeUndefined();
});

it.each([
  [{}, 'absent'],
  [{ GH_TOKEN: '' }, 'empty'],
  [{ GH_TOKEN: '   ' }, 'empty'],
  [{ GH_TOKEN: 'one', GITHUB_TOKEN: 'two' }, 'Conflicting'],
  [{ GH_TOKEN: 'one', gh_token: 'two' }, 'ambiguous'],
])('refuses missing, empty, conflicting, or ambiguous credentials', (parent, reason) => {
  expect(() => buildGovernedChildEnvironment(parent, 'GH_TOKEN')).toThrow(reason);
});

it('preserves inherited Git config while adding OpenSSL without collision', () => {
  const environment = buildGovernedChildEnvironment(
    {
      GH_TOKEN: 'fake-sentinel',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.one',
      GIT_CONFIG_VALUE_0: 'first',
      GIT_CONFIG_KEY_1: 'safe.two',
      GIT_CONFIG_VALUE_1: 'second',
    },
    'GH_TOKEN',
  );
  expect(environment).toMatchObject({
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'safe.one',
    GIT_CONFIG_VALUE_0: 'first',
    GIT_CONFIG_KEY_1: 'safe.two',
    GIT_CONFIG_VALUE_1: 'second',
    GIT_CONFIG_KEY_2: 'http.sslBackend',
    GIT_CONFIG_VALUE_2: 'openssl',
  });
});

it.each([
  { GH_TOKEN: 'fake', GIT_CONFIG_COUNT: 'not-a-number' },
  { GH_TOKEN: 'fake', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'only-key' },
  {
    GH_TOKEN: 'fake',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.sslBackend',
    GIT_CONFIG_VALUE_0: 'schannel',
  },
])('fails closed for malformed or conflicting inherited Git configuration', (parent) => {
  expect(() => buildGovernedChildEnvironment(parent, 'GH_TOKEN')).toThrow();
});

it('keeps the sentinel only in child env, never args, prompt, result, or errors', async () => {
  const sentinel = 'fake-sentinel-never-disclose';
  let capturedArgs: string[] = [];
  let capturedEnvironment: NodeJS.ProcessEnv = {};
  let probeEnvironment: NodeJS.ProcessEnv = {};
  const dispatcher = new CodexAgentDispatcher({
    executable: 'codex',
    allowedExecutable: 'codex',
    workingRoot: path.resolve('.'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: sentinel, PATH: 'safe-path' },
    versionProbe: async (_executable, environment) => {
      probeEnvironment = environment;
      return 'codex-cli 0.148.0';
    },
    spawnProcess: async (_executable, args, _cwd, _timeout, _signal, environment) => {
      capturedArgs = args;
      capturedEnvironment = environment;
      return {
        exitCode: 0,
        timedOut: false,
        model: 'fake',
        inputTokens: 0,
        outputTokens: 0,
        launched: true,
      };
    },
  });
  const result = await dispatcher.dispatch(
    {
      schema_version: '1',
      task: { id: 'TASK-016', path: 'task.md', fingerprint: 'sha256:fake' },
      role: 'Nova',
      state: 'DEVELOPMENT',
      dispatch_id: 'sha256:dispatch',
      evidence: ['safe-evidence'],
      instruction: 'safe instruction',
    },
    new AbortController().signal,
  );
  expect(capturedEnvironment.GH_TOKEN).toBe(sentinel);
  expect(probeEnvironment.GH_TOKEN).toBeUndefined();
  expect(JSON.stringify(capturedArgs)).not.toContain(sentinel);
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

it('refuses absent credential before probe or child launch', async () => {
  let probes = 0;
  let launches = 0;
  const dispatcher = new CodexAgentDispatcher({
    executable: 'codex',
    allowedExecutable: 'codex',
    workingRoot: path.resolve('.'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: {},
    versionProbe: async () => {
      probes++;
      return 'codex-cli 0.148.0';
    },
    spawnProcess: async () => {
      launches++;
      throw new Error('must not launch');
    },
  });
  await expect(
    dispatcher.dispatch(
      {
        schema_version: '1',
        task: { id: 'TASK-016', path: 'task.md', fingerprint: 'sha256:fake' },
        role: 'Nova',
        state: 'DEVELOPMENT',
        dispatch_id: 'sha256:dispatch',
        evidence: [],
        instruction: 'safe',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('absent');
  expect(probes).toBe(0);
  expect(launches).toBe(0);
});
