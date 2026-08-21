import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { hostname, tmpdir } from 'os';
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
  isLegalRunnerTransition,
  readRunnerTask,
  reconcileRunnerFacts,
  runCompany,
  runCompanyOnce,
  RunnerLedger,
  runnerStatus,
  spawnGovernedProcess,
  TaskLease,
  TransientPrelaunchError,
  validateApprovalPackage,
  validateApprovalPackageSchema,
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
const codexOutputSchemaPath = path.resolve(
  __dirname,
  '../../docs/schemas/company-runner-codex-output-v1.schema.json',
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
      outputSchemaPath: codexOutputSchemaPath,
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
      outputSchemaPath: codexOutputSchemaPath,
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
    outputSchemaPath: codexOutputSchemaPath,
    workingRoot: path.resolve('.'),
    approvedWorkingRoot: path.resolve('..'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: sentinel, PATH: 'safe-path' },
    versionProbe: async (_executable, environment) => {
      probeEnvironment = environment;
      return 'codex-cli 0.148.0';
    },
    capabilityProbe: async () =>
      '--json --output-schema <FILE> --cd <DIR> --sandbox <SANDBOX_MODE> --ask-for-approval <APPROVAL_POLICY>',
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
        output:
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"completed\\"}"}}\n',
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
    outputSchemaPath: codexOutputSchemaPath,
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

it('enforces every checked-in approval schema constraint and fails closed on schema drift', async () => {
  const sha = `sha256:${'a'.repeat(64)}`;
  const valid = {
    schema_version: '1',
    request_id: sha,
    created_at: '2026-08-20T00:00:00.000Z',
    agent: 'Nova',
    task: { id: 'TASK-16', path: 'tasks/active/task.md', fingerprint: sha },
    workflow_state: 'DEVELOPMENT',
    requested_action: 'DISPATCH_ROLE',
    reason: 'reason',
    affected_files_resources: ['one'],
    branch_pr: { repository: 'owner/repo', branch: 'task/x', pr: 23, head: 'a'.repeat(40) },
    external_effects: [],
    risk_approval_class: 'YELLOW',
    recommended_next_action: 'ask',
    evidence: [],
    run_id: 'run',
    dispatch_id: sha,
  };
  await expect(
    validateApprovalPackageSchema(valid as never, approvalSchemaPath),
  ).resolves.toBeUndefined();
  const invalid = [
    { ...valid, extra: true },
    { ...valid, request_id: 'bad' },
    { ...valid, created_at: 'bad' },
    { ...valid, agent: 'Unknown' },
    { ...valid, task: { ...valid.task, id: 'bad' } },
    { ...valid, task: { ...valid.task, extra: true } },
    { ...valid, affected_files_resources: [] },
    { ...valid, affected_files_resources: ['one', 'one'] },
    { ...valid, affected_files_resources: [1] },
    { ...valid, branch_pr: { ...valid.branch_pr, pr: 0 } },
    { ...valid, branch_pr: { ...valid.branch_pr, extra: true } },
    { ...valid, reason: '' },
    { ...valid, dispatch_id: 'bad' },
  ];
  for (const candidate of invalid)
    await expect(
      validateApprovalPackageSchema(candidate as never, approvalSchemaPath),
    ).rejects.toThrow('checked-in schema');
  const root = await mkdtemp(path.join(tmpdir(), 'runner-schema-'));
  roots.push(root);
  const corrupt = path.join(root, 'schema.json');
  await writeFile(corrupt, '{"type":"object","unsupported":true}');
  await expect(validateApprovalPackageSchema(valid as never, corrupt)).rejects.toThrow(
    'Unsupported',
  );
  await writeFile(corrupt, '{bad');
  await expect(validateApprovalPackageSchema(valid as never, corrupt)).rejects.toThrow('malformed');
});

it.each([
  '--json',
  '--output-schema <FILE>',
  '--cd <DIR>',
  '--sandbox <SANDBOX_MODE>',
  '--ask-for-approval <APPROVAL_POLICY>',
])('refuses Codex capability drift for %s before governed launch', async (missing) => {
  let launches = 0;
  const all = [
    '--json',
    '--output-schema <FILE>',
    '--cd <DIR>',
    '--sandbox <SANDBOX_MODE>',
    '--ask-for-approval <APPROVAL_POLICY>',
  ];
  const dispatcher = new CodexAgentDispatcher({
    executable: 'codex',
    allowedExecutable: 'codex',
    outputSchemaPath: codexOutputSchemaPath,
    workingRoot: path.resolve('.'),
    approvedWorkingRoot: path.resolve('..'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: 'fake' },
    versionProbe: async () => 'codex-cli 0.148.0',
    capabilityProbe: async () => all.filter((flag) => flag !== missing).join(' '),
    spawnProcess: async () => {
      launches++;
      throw new Error('must not launch');
    },
  });
  await expect(
    dispatcher.dispatch(
      {
        schema_version: '1',
        task: { id: 'TASK-016', path: 'x', fingerprint: 'x' },
        role: 'Nova',
        state: 'DEVELOPMENT',
        dispatch_id: 'x',
        evidence: [],
        instruction: 'x',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('missing');
  expect(launches).toBe(0);
});

it.each([
  '',
  'not-json\n',
  '{"type":"turn.completed"}\n',
  '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"unknown\\"}"}}\n',
  '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"outcome\\":\\"completed\\",\\"extra\\":true}"}}\n',
])('rejects malformed or schema-invalid Codex output %j', async (output) => {
  const dispatcher = new CodexAgentDispatcher({
    executable: 'codex',
    allowedExecutable: 'codex',
    outputSchemaPath: codexOutputSchemaPath,
    workingRoot: path.resolve('.'),
    approvedWorkingRoot: path.resolve('..'),
    timeoutMs: 10,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: 'fake' },
    versionProbe: async () => 'codex-cli 0.148.0',
    capabilityProbe: async () =>
      '--json --output-schema <FILE> --cd <DIR> --sandbox <SANDBOX_MODE> --ask-for-approval <APPROVAL_POLICY>',
    spawnProcess: async (_e, args) => {
      expect(args).toEqual([
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'on-request',
        '--cd',
        path.resolve('.'),
        '--output-schema',
        codexOutputSchemaPath,
        expect.any(String),
      ]);
      return {
        exitCode: 0,
        timedOut: false,
        model: 'fake',
        inputTokens: 0,
        outputTokens: 0,
        launched: true,
        output,
      };
    },
  });
  await expect(
    dispatcher.dispatch(
      {
        schema_version: '1',
        task: { id: 'TASK-016', path: 'x', fingerprint: 'x' },
        role: 'Nova',
        state: 'DEVELOPMENT',
        dispatch_id: 'x',
        evidence: [],
        instruction: 'x',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/JSONL|output schema/);
});

it('accepts a transition only with unique preceding role-owned current-head evidence', async () => {
  const { root, task, stateDir } = await fixture();
  const dispatcher = new FakeAgentDispatcher();
  dispatcher.dispatch = async (packet) => {
    dispatcher.calls.push(packet);
    const evidence = 'documentation/qa/nova-handoff.md';
    await writeFile(
      path.join(root, evidence),
      `Nova\nDEVELOPMENT to READY_FOR_QA\n${githubFacts.head}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = (await readFile(task, 'utf8'))
      .replace('**Owner:** Nova', '**Owner:** Pixel')
      .replace('**Current state:** DEVELOPMENT', '**Current state:** READY_FOR_QA')
      .concat(
        `- **New evidence:** \`${evidence}\`\n| now | Nova | Pixel | \`DEVELOPMENT\` to \`READY_FOR_QA\` | ${evidence} | retest |\n`,
      );
    const destination = path.join(root, 'tasks', 'review', 'task.md');
    await writeFile(task, next);
    await rename(task, destination);
    return {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: true,
    };
  };
  await expect(
    runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher,
      githubResolver,
    }),
  ).resolves.toMatchObject({ outcome: 'DISPATCHED' });
  expect(
    (await new RunnerLedger(path.join(stateDir, 'TASK-016.jsonl')).read()).some(
      (event) => event.type === 'observed_transition',
    ),
  ).toBe(true);
});

it('refuses a transition supported only by historical evidence', async () => {
  const { root, task, stateDir } = await fixture();
  const dispatcher = new FakeAgentDispatcher();
  dispatcher.dispatch = async () => {
    const next = (await readFile(task, 'utf8'))
      .replace('**Owner:** Nova', '**Owner:** Pixel')
      .replace('**Current state:** DEVELOPMENT', '**Current state:** READY_FOR_QA');
    await writeFile(task, next);
    await rename(task, path.join(root, 'tasks', 'review', 'task.md'));
    return {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: true,
    };
  };
  await expect(
    runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher,
      githubResolver,
    }),
  ).rejects.toThrow('newly linked evidence');
});

it.each([
  ['terminal', 'COMPLETED', 'Alex', undefined],
  ['stop', 'DEVELOPMENT', 'Nova', 'stop'],
] as const)(
  'serializes concurrent %s audit writes into one valid chain',
  async (_name, state, owner, stop) => {
    const { root, stateDir } = await fixture(state, owner);
    const stopFile = stop ? path.join(root, 'STOP') : undefined;
    if (stopFile) await writeFile(stopFile, 'stop');
    await Promise.all(
      [0, 1, 2].map(() =>
        runCompanyOnce({
          companyRoot: root,
          taskId: 'TASK-016',
          stateDirectory: stateDir,
          dispatcher: new FakeAgentDispatcher(),
          githubResolver,
          stopFile,
        }),
      ),
    );
    const events = await new RunnerLedger(path.join(stateDir, 'TASK-016.jsonl')).read();
    expect(events.length).toBeGreaterThan(0);
  },
);

it('recovers only an expired dead-owner lease and preserves a live owner', async () => {
  const { root, stateDir } = await fixture();
  const decision = decideRunnerAction(await readRunnerTask(root, 'TASK-016'));
  const file = path.join(stateDir, 'leases', 'TASK-016.lock');
  await mkdir(path.dirname(file), { recursive: true });
  const lease = (pid: number, expires: string) => ({
    task_id: 'TASK-016',
    run_id: 'old',
    dispatch_id: 'old',
    pid,
    host: hostname(),
    acquired_at: expires,
    heartbeat_at: expires,
    expires_at: expires,
    state_fingerprint: 'old',
  });
  const expired = new Date(Date.now() - 1000).toISOString();
  await writeFile(file, JSON.stringify(lease(2147483647, expired)));
  const recovered = new TaskLease(file, 1000);
  expect(await recovered.acquire(decision, 'new')).toBe('recovered');
  await recovered.release('new');
  await writeFile(file, JSON.stringify(lease(process.pid, expired)));
  expect(await new TaskLease(file, 1000).acquire(decision, 'other')).toBe('contended');
});

it.each(['dispatch_intent', 'dispatch_start'])(
  'restart refuses ambiguous %s crash evidence without redispatch',
  async (type) => {
    const { root, stateDir } = await fixture();
    const task = await readRunnerTask(root, 'TASK-016');
    const decision = decideRunnerAction(
      task,
      await reconcileRunnerFacts(root, task, githubResolver),
    );
    await new RunnerLedger(path.join(stateDir, 'TASK-016.jsonl')).append({
      type,
      run_id: 'crashed',
      dispatch_id: decision.dispatch_id,
      task_fingerprint: decision.state_fingerprint,
      outcome: 'PERSISTED',
      details: {},
    });
    const fake = new FakeAgentDispatcher();
    const result = await runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher: fake,
      githubResolver,
    });
    expect(result.outcome).toBe('RECOVERY_REQUIRED');
    expect(fake.calls).toHaveLength(0);
  },
);

it('opens the persisted circuit after restart and performs zero dispatch', async () => {
  const { root, stateDir } = await fixture();
  const ledger = new RunnerLedger(path.join(stateDir, 'TASK-016.jsonl'));
  for (let index = 0; index < 3; index++)
    await ledger.append({
      type: 'failure',
      run_id: `old-${index}`,
      dispatch_id: `old-${index}`,
      task_fingerprint: 'old',
      outcome: 'FAILED',
      details: {},
    });
  const fake = new FakeAgentDispatcher();
  const result = await runCompanyOnce({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher: fake,
    githubResolver,
  });
  expect(result.outcome).toBe('FAILED');
  expect(fake.calls).toHaveLength(0);
  expect((await runnerStatus(root, 'TASK-016', stateDir)).circuit).toBe('open');
});

it('fails closed when heartbeat persistence is lost during dispatch', async () => {
  const { root, stateDir } = await fixture();
  const dispatcher = new FakeAgentDispatcher();
  dispatcher.dispatch = async () => {
    await rm(path.join(stateDir, 'leases', 'TASK-016.lock'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: true,
    };
  };
  await expect(
    runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher,
      githubResolver,
      heartbeatMs: 5,
    }),
  ).rejects.toThrow();
});

it('fails closed when dispatch completion races ahead of the first heartbeat', async () => {
  const { root, stateDir } = await fixture();
  const dispatcher = new FakeAgentDispatcher();
  dispatcher.dispatch = async () => {
    await rm(path.join(stateDir, 'leases', 'TASK-016.lock'));
    return {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: true,
    };
  };
  await expect(
    runCompanyOnce({
      companyRoot: root,
      taskId: 'TASK-016',
      stateDirectory: stateDir,
      dispatcher,
      githubResolver,
      heartbeatMs: 60_000,
    }),
  ).rejects.toThrow();
});

it('bounds idle event loss without polling or redispatch', async () => {
  const { root, stateDir } = await fixture();
  const fake = new FakeAgentDispatcher();
  const result = await runCompany({
    companyRoot: root,
    taskId: 'TASK-016',
    stateDirectory: stateDir,
    dispatcher: fake,
    githubResolver,
    maxDispatches: 2,
    idleTimeoutMs: 10,
    waitForEvent: async () => new Promise(() => undefined),
  });
  expect(result.stop_reason).toBe('IDLE_TIMEOUT');
  expect(fake.calls).toHaveLength(1);
});

it('terminates a real unresponsive child and proves it no longer survives', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-child-'));
  roots.push(root);
  const pidFile = path.join(root, 'pid.txt');
  const controller = new AbortController();
  const work = spawnGovernedProcess(
    process.execPath,
    [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
    ],
    root,
    5000,
    controller.signal,
    process.env,
  );
  while (!(await readFile(pidFile, 'utf8').catch(() => '')))
    await new Promise((resolve) => setTimeout(resolve, 5));
  const pid = Number(await readFile(pidFile, 'utf8'));
  controller.abort();
  const result = await work;
  expect(result.timedOut).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

it.each([
  ['BACKLOG', 'DEVELOPMENT'],
  ['BACKLOG', 'BLOCKED'],
  ['DEVELOPMENT', 'READY_FOR_QA'],
  ['DEVELOPMENT', 'BLOCKED'],
  ['READY_FOR_QA', 'QA'],
  ['READY_FOR_QA', 'BLOCKED'],
  ['QA', 'READY_FOR_REVIEW'],
  ['QA', 'CHANGES_REQUIRED'],
  ['QA', 'BLOCKED'],
  ['CHANGES_REQUIRED', 'QA_RETEST'],
  ['CHANGES_REQUIRED', 'BLOCKED'],
  ['QA_RETEST', 'READY_FOR_REVIEW'],
  ['QA_RETEST', 'CHANGES_REQUIRED'],
  ['QA_RETEST', 'BLOCKED'],
  ['READY_FOR_REVIEW', 'REVIEW'],
  ['READY_FOR_REVIEW', 'BLOCKED'],
  ['REVIEW', 'APPROVED'],
  ['REVIEW', 'CHANGES_REQUIRED'],
  ['REVIEW', 'BLOCKED'],
  ['APPROVED', 'COMPLETED'],
  ['APPROVED', 'BLOCKED'],
  ['BLOCKED', 'QA_RETEST'],
] as const)(
  'recognizes governed transition %s -> %s without adding a competing lifecycle',
  (from, to) => {
    const before = {
      state: from,
      ...(from === 'BLOCKED' ? { resumeState: 'QA_RETEST' } : {}),
    } as never;
    expect(isLegalRunnerTransition(before, { state: to } as never)).toBe(true);
  },
);
