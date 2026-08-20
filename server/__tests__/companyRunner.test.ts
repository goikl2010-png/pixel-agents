import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, expect, it } from 'vitest';

import {
  buildGovernedChildEnvironment,
  CodexAgentDispatcher,
  decideRunnerAction,
  evaluateGovernanceAction,
  FakeAgentDispatcher,
  GhCliGitHubFactResolver,
  type GitHubFactResolver,
  readRunnerTask,
  runCompany,
  runCompanyOnce,
  RunnerLedger,
  runnerStatus,
  TaskLease,
  TransientPrelaunchError,
  validateApprovalPackage,
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
const githubFacts = {
  repository: 'owner/repo',
  issue: 22,
  issueState: 'OPEN' as const,
  pr: 23,
  prState: 'OPEN' as const,
  draft: true,
  base: 'main',
  branch: 'task/TASK-016-company-runner-v1',
  head: 'a'.repeat(40),
};
const githubResolver: GitHubFactResolver = { resolve: async () => githubFacts };
const approvalSchemaPath = path.resolve(
  __dirname,
  '../../docs/schemas/company-runner-approval-v1.schema.json',
);
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
  await mkdir(path.join(root, 'documentation', 'qa'), { recursive: true });
  await writeFile(
    path.join(root, 'documentation', 'qa', 'report.md'),
    `PASSED at ${'a'.repeat(40)}\n`,
  );
  await writeFile(
    task,
    `# TASK-016\n- **Task ID:** TASK-016\n- **Owner:** ${owner}\n- **Current state:** ${state}\n- **Resume state (required only when BLOCKED):** ${resume}\n- **Repository:** owner/repo\n- **GitHub Issue URL/number:** Issue #22\n- **Pull Request URL/number:** PR #23\n- **Base branch:** main\n- **Feature branch:** task/TASK-016-company-runner-v1\n- **Current PR head commit:** ${'a'.repeat(40)}\n- **Evidence link:** \`documentation/qa/report.md\`\n`,
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
    githubResolver,
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
        githubResolver,
        approvalSchemaPath,
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
        githubResolver,
      })
    ).outcome,
  ).toBe('NO_ACTION_UNCHANGED');
  expect(first.calls).toHaveLength(1);
  expect(second.calls).toHaveLength(0);
  await expect(runnerStatus(root, 'TASK-016', stateDir)).resolves.toMatchObject({
    dispatch_count: 1,
    lease: { status: 'free' },
    model: 'fake',
  });
});

it('fails closed before dispatch for missing evidence or unavailable/conflicting GitHub facts', async () => {
  const { root, stateDir } = await fixture();
  const fake = new FakeAgentDispatcher();
  await rm(path.join(root, 'documentation', 'qa', 'report.md'));
  await expect(
    runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher: fake,
    }),
  ).rejects.toThrow('evidence');
  expect(fake.calls).toHaveLength(0);

  const second = await fixture();
  await expect(
    runCompanyOnce({
      companyRoot: second.root,
      taskId: 'TASK-016',
      stateDirectory: second.stateDir,
      dispatcher: fake,
    }),
  ).rejects.toThrow('GitHub facts');
  const conflicting: GitHubFactResolver = {
    resolve: async () => ({ ...githubFacts, head: 'b'.repeat(40) }),
  };
  await expect(
    runCompanyOnce({
      companyRoot: second.root,
      taskId: 'TASK-016',
      stateDirectory: second.stateDir,
      dispatcher: fake,
      githubResolver: conflicting,
    }),
  ).rejects.toThrow('conflicts');
  expect(fake.calls).toHaveLength(0);
});

it('resolves typed live GitHub facts through fixed gh API paths without disclosing credentials', async () => {
  const { root } = await fixture();
  const task = await readRunnerTask(root, 'TASK-016');
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const resolver = new GhCliGitHubFactResolver({
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: 'fake-live-fact-sentinel', PATH: 'safe' },
    run: async (_executable, args, env) => {
      calls.push({ args, env });
      return args[1].includes('/issues/')
        ? { state: 'open' }
        : {
            state: 'open',
            draft: true,
            merged_at: null,
            base: { ref: 'main' },
            head: { ref: githubFacts.branch, sha: githubFacts.head },
          };
    },
  });
  await expect(resolver.resolve(task, new AbortController().signal)).resolves.toEqual(githubFacts);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.env.GH_TOKEN === 'fake-live-fact-sentinel')).toBe(true);
  expect(JSON.stringify(calls.map((call) => call.args))).not.toContain('fake-live-fact-sentinel');
});

it('serializes a real concurrent race to one dispatch', async () => {
  const { root, stateDir } = await fixture();
  const slow = new FakeAgentDispatcher();
  slow.dispatch = async (packet, signal) => {
    slow.calls.push(packet);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: !signal.aborted,
    };
  };
  const other = new FakeAgentDispatcher();
  const base = { companyRoot: root, taskId: 'TASK-016', stateDirectory: stateDir, githubResolver };
  const [a, b] = await Promise.all([
    runCompanyOnce({ ...base, dispatcher: slow }),
    runCompanyOnce({ ...base, dispatcher: other }),
  ]);
  expect([a.outcome, b.outcome]).toContain('LEASE_CONTENDED');
  expect(slow.calls.length + other.calls.length).toBe(1);
  expect(await new RunnerLedger(path.join(stateDir, 'TASK-016.jsonl')).read()).not.toHaveLength(0);
});

it('renews leases atomically and refuses owner-mismatched release', async () => {
  const { root, stateDir } = await fixture();
  const decision = decideRunnerAction(await readRunnerTask(root, 'TASK-016'));
  const lease = new TaskLease(path.join(stateDir, 'leases', 'TASK-016.lock'), 50);
  expect(await lease.acquire(decision, 'owner')).toBe('acquired');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await lease.renew('owner');
  await expect(lease.release('intruder')).rejects.toThrow('owner mismatch');
  await lease.release('owner');
});

it('retries only one explicitly transient pre-launch failure', async () => {
  const { root, stateDir } = await fixture();
  let calls = 0;
  const dispatcher = {
    dispatch: async () => {
      calls++;
      if (calls === 1) throw new TransientPrelaunchError('temporary spawn refusal');
      return {
        exitCode: 0,
        timedOut: false,
        model: 'fake' as const,
        inputTokens: 0 as const,
        outputTokens: 0 as const,
        launched: true,
      };
    },
  };
  await runCompanyOnce({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher,
    githubResolver,
  });
  expect(calls).toBe(2);
  expect((await runnerStatus(root, 'TASK-016', stateDir)).retry_count).toBe(1);
});

it('defaults to one dispatch and enforces the hard four-dispatch process ceiling', async () => {
  const { root, stateDir } = await fixture();
  const fake = new FakeAgentDispatcher();
  const result = await runCompany({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher: fake,
    githubResolver,
  });
  expect(result.stop_reason).toBe('RUN_ONCE');
  expect(fake.calls).toHaveLength(1);
  await expect(
    runCompany({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: path.join(root, '.other-runner'),
      dispatcher: new FakeAgentDispatcher(),
      githubResolver,
      maxDispatches: 5,
    }),
  ).rejects.toThrow('one through four');
});

it('classifies governance effects deterministically and validates complete packages', async () => {
  expect(evaluateGovernanceAction(['READ_ONLY'], 'managed-on-request')).toBe('GREEN');
  expect(evaluateGovernanceAction(['PR_UPDATE'], 'managed-on-request')).toBe('YELLOW');
  expect(evaluateGovernanceAction(['MAIN_MERGE'], 'managed-on-request')).toBe('RED');
  expect(evaluateGovernanceAction(['AMBIGUOUS'], 'managed-on-request')).toBe('UNKNOWN');
  expect(evaluateGovernanceAction(['READ_ONLY'])).toBe('UNKNOWN');
  expect(() => validateApprovalPackage({} as never)).toThrow('contract');
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
        githubResolver,
        approvalSchemaPath,
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
    githubResolver,
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
      approvedWorkingRoot: path.resolve('.'),
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
      approvedWorkingRoot: path.resolve('.'),
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
    approvedWorkingRoot: path.resolve('.'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: sentinel, PATH: 'safe-path' },
    versionProbe: async (_executable, environment) => {
      probeEnvironment = environment;
      return 'codex-cli 0.148.0';
    },
    capabilityProbe: async () => 'exec --json --output-schema --cd --sandbox',
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
    approvedWorkingRoot: path.resolve('.'),
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
