import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, expect, it } from 'vitest';

import type { EmployeeIdentity } from '../src/actionableTaskDiscovery.js';
import {
  type AgentDispatcher,
  CodexAgentDispatcher,
  type GitHubFactResolver,
  readRunnerTask,
  runCompanyOnce,
  RunnerLedger,
} from '../src/companyRunner.js';
import {
  AGENT_RESULT_V1,
  type AgentResultV1,
  buildContextManifestV1,
  ManifestBoundGitPublisher,
  MarkdownRunnerTransitionWriter,
  SpecialistCheckpointStore,
  validateAgentResultV1,
  validateWorkspaceDescriptorV1,
  type WorkspaceDescriptorV1,
} from '../src/companyRunnerContract.js';
import {
  type CompanyRunnerV1Manifest,
  launchCompanyRunnerV1,
} from '../src/companyRunnerV1Launcher.js';
import type { LifecycleState } from '../src/handoffTransitionPlanner.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BRANCH = 'task/TASK-051-v1-rescue-common-contract';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), 'runner-contract-'));
  roots.push(result);
  return result;
}

function descriptor(
  workspace: string,
  role: EmployeeIdentity,
  publication: 'required' | 'not-required' = 'not-required',
): WorkspaceDescriptorV1 {
  return {
    schema_version: '1',
    task_id: 'TASK-051',
    role,
    repository: 'owner/repo',
    root: workspace,
    branch: BRANCH,
    base_sha: BASE,
    allowed_paths: ['src/authorized.ts'],
    protected_paths: ['config/governance-integrity.json'],
    publication,
  };
}

function result(
  role: EmployeeIdentity,
  fromState: LifecycleState,
  nextState: LifecycleState,
  contextHash: string,
  summary = `${role} completed specialist work`,
): AgentResultV1 {
  return {
    contract: AGENT_RESULT_V1,
    schema_version: '1',
    task_id: 'TASK-051',
    role,
    from_state: fromState,
    outcome: 'completed',
    next_state: nextState,
    summary,
    evidence: [HEAD],
    publication: null,
    completion:
      fromState === 'APPROVED' && nextState === 'COMPLETED'
        ? {
            repository: 'owner/repo',
            issue: 75,
            pull_request: 76,
            branch: BRANCH,
            head_sha: HEAD,
            merge_sha: 'c'.repeat(40),
            issue_state: 'CLOSED',
            pull_request_state: 'MERGED',
          }
        : null,
    context_manifest_sha256: contextHash,
  };
}

it.each(['Alex', 'Nova', 'Pixel', 'Atlas'] as const)(
  'validates the same AgentResultV1 doorway for %s',
  (role) => {
    const contextHash = `sha256:${'c'.repeat(64)}`;
    expect(
      validateAgentResultV1(result(role, 'DEVELOPMENT', 'READY_FOR_QA', contextHash), {
        taskId: 'TASK-051',
        role,
        state: 'DEVELOPMENT',
        contextManifestSha256: contextHash,
      }),
    ).toMatchObject({ contract: AGENT_RESULT_V1, role, outcome: 'completed' });
  },
);

it('Codex dispatcher accepts the checked-in AgentResultV1 schema and returns the structured result', async () => {
  const workspace = await root();
  const checkedInSchema = path.resolve(
    __dirname,
    '../../docs/schemas/company-runner-agent-result-v1.schema.json',
  );
  const schemaPath = path.join(workspace, 'agent-result.schema.json');
  await writeFile(schemaPath, await readFile(checkedInSchema));
  const contextHash = `sha256:${'c'.repeat(64)}`;
  const agentResult = result('Nova', 'DEVELOPMENT', 'READY_FOR_QA', contextHash);
  const dispatcher = new CodexAgentDispatcher({
    executable: 'codex',
    allowedExecutable: 'codex',
    workingRoot: workspace,
    approvedWorkingRoot: workspace,
    outputSchemaPath: schemaPath,
    timeoutMs: 5_000,
    credentialEnvironmentVariable: 'GH_TOKEN',
    parentEnvironment: { GH_TOKEN: 'test-only' },
    versionProbe: async () => 'codex-cli 0.154.0',
    globalCapabilityProbe: async () =>
      '-a, --ask-for-approval <APPROVAL_POLICY>\n- on-request: Ask when needed',
    capabilityProbe: async () =>
      '--json --output-schema <FILE> --cd <DIR> --sandbox <SANDBOX_MODE>',
    spawnProcess: async () => ({
      exitCode: 0,
      timedOut: false,
      model: 'fixture',
      inputTokens: 1,
      outputTokens: 1,
      launched: true,
      output: `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(agentResult) },
      })}\n`,
    }),
  });
  await expect(
    dispatcher.dispatch(
      {
        schema_version: '1',
        task: { id: 'TASK-051', path: 'task.md', fingerprint: contextHash },
        role: 'Nova',
        state: 'DEVELOPMENT',
        dispatch_id: contextHash,
        evidence: [],
        instruction: 'fixture',
        contract: AGENT_RESULT_V1,
        workspace: descriptor(workspace, 'Nova'),
        context_manifest: {
          schema_version: '1',
          task_id: 'TASK-051',
          role: 'Nova',
          entries: [],
          manifest_sha256: contextHash,
        },
      },
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ agentOutcome: 'completed', agentResult });
});

it('builds a deterministic hashable context manifest and carries an earlier checkpoint forward', async () => {
  const directory = await root();
  const memory = path.join(directory, 'COMPANY-MEMORY.md');
  const task = path.join(directory, 'task.md');
  const checkpoint = path.join(directory, 'checkpoint.json');
  await Promise.all([
    writeFile(memory, 'durable company context\n'),
    writeFile(task, 'authoritative task context\n'),
    writeFile(checkpoint, 'earlier specialist checkpoint\n'),
  ]);
  const options = {
    taskId: 'TASK-051',
    role: 'Atlas' as const,
    roots: [directory],
    sources: [
      { id: 'task', path: task },
      { id: 'company-memory', path: memory },
      { id: 'prior-checkpoint', path: checkpoint },
    ],
  };
  const first = await buildContextManifestV1(options);
  const second = await buildContextManifestV1({
    ...options,
    sources: [...options.sources].reverse(),
  });
  expect(first).toEqual(second);
  expect(first.entries.map((entry) => entry.id)).toContain('prior-checkpoint');
  expect(first.entries.every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
});

it('publishes one exact allowlisted commit and rejects protected or unrelated paths', async () => {
  const directory = await root();
  const remote = path.join(directory, 'remote.git');
  const workspace = path.join(directory, 'workspace');
  await execFileAsync('git', ['init', '--bare', remote]);
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, 'config'), { recursive: true });
  await execFileAsync('git', ['init', '-b', BRANCH], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'runner@example.invalid'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Company Runner Test'], { cwd: workspace });
  await writeFile(path.join(workspace, 'src', 'authorized.ts'), 'export const value = 1;\n');
  await execFileAsync('git', ['add', 'src/authorized.ts'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: workspace });
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: workspace });
  await execFileAsync('git', ['push', '-u', 'origin', BRANCH], { cwd: workspace });
  const base = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })
  ).stdout.trim();
  await writeFile(path.join(workspace, 'src', 'authorized.ts'), 'export const value = 2;\n');
  let ensuredPullRequests = 0;
  let verifiedPullRequests = 0;
  const publisher = new ManifestBoundGitPublisher(
    'git',
    async (executable, args, cwd) => {
      if (args.slice(-3).join(' ') === 'remote get-url origin')
        return { stdout: 'https://github.com/owner/repo.git\n', stderr: '' };
      const completed = await execFileAsync(executable, args, { cwd });
      return { stdout: completed.stdout, stderr: completed.stderr };
    },
    async (repository, branch, request) => {
      expect(repository).toBe('owner/repo');
      expect(branch).toBe(BRANCH);
      expect(request).toEqual({
        base: 'main',
        title: 'TASK-051 rescue',
        body: 'Open the exact authorized rescue Pull Request.',
      });
      ensuredPullRequests++;
      return {
        number: 76,
        url: 'https://github.com/owner/repo/pull/76',
        base: 'main',
        head: BRANCH,
      };
    },
    async (repository, claim) => {
      expect(repository).toBe('owner/repo');
      expect(claim).toEqual({
        number: 76,
        url: 'https://github.com/owner/repo/pull/76',
        base: 'main',
        head: BRANCH,
      });
      verifiedPullRequests++;
    },
  );
  const manifest = { ...descriptor(workspace, 'Nova', 'required'), base_sha: base };
  const receipt = await publisher.publish(manifest, {
    repository: 'owner/repo',
    branch: BRANCH,
    base_sha: base,
    changed_paths: ['src/authorized.ts'],
    commit_message: 'TASK-051 authorized change',
    pull_request: {
      base: 'main',
      title: 'TASK-051 rescue',
      body: 'Open the exact authorized rescue Pull Request.',
    },
  });
  await expect(publisher.verifyReceipt(manifest, receipt)).resolves.toBeUndefined();
  expect(receipt.commit_sha).toBe(receipt.remote_sha);
  expect(receipt.changed_paths).toEqual(['src/authorized.ts']);
  expect(ensuredPullRequests).toBe(1);
  expect(verifiedPullRequests).toBe(2);

  await writeFile(path.join(workspace, 'config', 'governance-integrity.json'), '{}\n');
  await expect(
    publisher.publish(
      { ...manifest, base_sha: receipt.commit_sha },
      {
        repository: 'owner/repo',
        branch: BRANCH,
        base_sha: receipt.commit_sha,
        changed_paths: ['config/governance-integrity.json'],
        commit_message: 'forbidden',
        pull_request: null,
      },
    ),
  ).rejects.toThrow(/non-allowlisted|protected/);
});

interface LifecycleFixture {
  company: string;
  workspace: string;
  stateDirectory: string;
  memory: string;
}

async function lifecycleFixture(): Promise<LifecycleFixture> {
  const company = await root();
  const workspace = path.join(company, 'workspace');
  const stateDirectory = path.join(company, '.runner');
  await Promise.all(
    ['backlog', 'active', 'review', 'completed'].map((store) =>
      mkdir(path.join(company, 'tasks', store), { recursive: true }),
    ),
  );
  await mkdir(workspace, { recursive: true });
  const memory = path.join(company, 'COMPANY-MEMORY.md');
  await writeFile(memory, 'durable memory from an earlier company action\n');
  await writeFile(
    path.join(company, 'tasks', 'backlog', 'task.md'),
    `# TASK-051
- **Task ID:** TASK-051
- **Owner:** Alex
- **Current state:** BACKLOG
- **Previous state:** None
- **Resume state (required only when BLOCKED):** None
- **Repository:** owner/repo
- **GitHub Issue URL/number:** Issue #75
- **Pull Request URL/number:** PR #76
- **Base branch:** main
- **Feature branch:** ${BRANCH}
- **Current PR head commit:** ${HEAD}

## Handoff History

| Date/time | From | To | State transition | Evidence verified or supplied | Next required action |
| --- | --- | --- | --- | --- | --- |
`,
  );
  return { company, workspace, stateDirectory, memory };
}

const githubResolver: GitHubFactResolver = {
  resolve: async () => ({
    repository: 'owner/repo',
    issue: 75,
    issueState: 'OPEN',
    pr: 76,
    prState: 'OPEN',
    draft: false,
    base: 'main',
    branch: BRANCH,
    head: HEAD,
  }),
};

const transitions: Record<
  LifecycleState,
  { role: EmployeeIdentity; next: LifecycleState; summary: string }
> = {
  BACKLOG: { role: 'Alex', next: 'DEVELOPMENT', summary: 'Alex authorized development' },
  DEVELOPMENT: { role: 'Nova', next: 'READY_FOR_QA', summary: 'Nova completed implementation' },
  READY_FOR_QA: { role: 'Pixel', next: 'QA', summary: 'Pixel accepted QA' },
  QA: { role: 'Pixel', next: 'READY_FOR_REVIEW', summary: 'Pixel PASSED current-head QA' },
  CHANGES_REQUIRED: { role: 'Nova', next: 'QA_RETEST', summary: 'Nova completed corrections' },
  QA_RETEST: { role: 'Pixel', next: 'READY_FOR_REVIEW', summary: 'Pixel PASSED retest' },
  READY_FOR_REVIEW: { role: 'Atlas', next: 'REVIEW', summary: 'Atlas accepted review' },
  REVIEW: { role: 'Atlas', next: 'APPROVED', summary: 'Atlas APPROVED current head' },
  APPROVED: { role: 'Alex', next: 'COMPLETED', summary: 'Alex verified closure and completion' },
  BLOCKED: { role: 'Alex', next: 'DEVELOPMENT', summary: 'unused' },
  COMPLETED: { role: 'Alex', next: 'COMPLETED', summary: 'unused' },
};

function lifecycleDispatcher(calls: EmployeeIdentity[]): AgentDispatcher {
  return {
    dispatch: async (packet) => {
      calls.push(packet.role);
      const planned = transitions[packet.state];
      return {
        exitCode: 0,
        timedOut: false,
        model: 'contract-fixture',
        inputTokens: 1,
        outputTokens: 1,
        launched: true,
        agentOutcome: 'completed',
        agentResult: result(
          packet.role,
          packet.state,
          planned.next,
          packet.context_manifest!.manifest_sha256,
          planned.summary,
        ),
      };
    },
  };
}

function contract(
  fixture: LifecycleFixture,
  transitionWriter?: MarkdownRunnerTransitionWriter,
  completionVerifier?: (completion: NonNullable<AgentResultV1['completion']>) => Promise<void>,
) {
  return {
    workspace: async (_task: unknown, role: EmployeeIdentity) =>
      descriptor(fixture.workspace, role),
    contextRoots: [fixture.company],
    contextSources: async (task: { path: string }) => [
      { id: 'authoritative-task', path: task.path },
      { id: 'company-memory', path: fixture.memory },
    ],
    checkpointStore: new SpecialistCheckpointStore(
      path.join(fixture.stateDirectory, 'checkpoints'),
    ),
    transitionWriter: transitionWriter ?? new MarkdownRunnerTransitionWriter(fixture.company),
    completionVerifier:
      completionVerifier ??
      (async (completion: NonNullable<AgentResultV1['completion']>) => {
        expect(completion).toMatchObject({
          repository: 'owner/repo',
          issue: 75,
          pull_request: 76,
          issue_state: 'CLOSED',
          pull_request_state: 'MERGED',
        });
      }),
    ownerAuthorizedAlexCompletion: true,
  };
}

async function launcherManifest(
  fixture: LifecycleFixture,
  activationHold: boolean,
): Promise<{ path: string; bytes: string }> {
  const schema = path.join(fixture.company, 'agent-result.schema.json');
  const runnerWorktree = path.join(fixture.company, 'runner-live');
  await mkdir(runnerWorktree, { recursive: true });
  await writeFile(schema, '{}\n');
  const manifest: CompanyRunnerV1Manifest = {
    schema_version: '1',
    activation_hold: activationHold,
    task_id: 'TASK-051',
    company_root: fixture.company,
    runner_worktree: runnerWorktree,
    state_directory: fixture.stateDirectory,
    stop_file: path.join(fixture.stateDirectory, 'STOP'),
    executable: path.join(fixture.company, 'codex'),
    output_schema: schema,
    timeout_ms: 5_000,
    lease_ttl_ms: 5_000,
    heartbeat_ms: 100,
    circuit_failure_threshold: 3,
    workspaces: (['Alex', 'Nova', 'Pixel', 'Atlas'] as const).map((role) =>
      descriptor(fixture.workspace, role),
    ),
    context_sources: [
      {
        id: 'company-memory',
        path: fixture.memory,
        roles: ['Alex', 'Nova', 'Pixel', 'Atlas'],
      },
    ],
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(fixture.company, 'runner-v1.json');
  await writeFile(manifestPath, bytes);
  return { path: manifestPath, bytes };
}

it('general launcher selects the authoritative role and preserves the HOLD boundary', async () => {
  const heldFixture = await lifecycleFixture();
  const held = await launcherManifest(heldFixture, true);
  const heldAuthorization = {
    schema_version: '1' as const,
    authorization: 'RED' as const,
    authorized_by: 'Goi' as const,
    task_id: 'TASK-051',
    manifest_sha256: `sha256:${createHash('sha256').update(held.bytes).digest('hex')}`,
  };
  const gates: Array<{ consumer: string; workspace: string }> = [];
  await expect(
    launchCompanyRunnerV1({
      manifestPath: held.path,
      authorization: heldAuthorization,
      governanceGate: async (_role, _taskId, workspace, consumer) => {
        gates.push({ consumer, workspace });
      },
      dispatcher: lifecycleDispatcher([]),
      githubResolver,
    }),
  ).rejects.toThrow('HOLD');
  expect(gates).toEqual([]);

  const fixture = await lifecycleFixture();
  const active = await launcherManifest(fixture, false);
  const calls: EmployeeIdentity[] = [];
  await expect(
    launchCompanyRunnerV1({
      manifestPath: active.path,
      authorization: {
        ...heldAuthorization,
        manifest_sha256: `sha256:${createHash('sha256').update(active.bytes).digest('hex')}`,
      },
      governanceGate: async (role, taskId, workspace, consumer) => {
        expect(role).toBe('Alex');
        expect(taskId).toBe('TASK-051');
        gates.push({ consumer, workspace });
      },
      dispatcher: lifecycleDispatcher(calls),
      githubResolver,
    }),
  ).resolves.toMatchObject({ outcome: 'DISPATCHED', decision: { owner: 'Alex' } });
  expect(calls).toEqual(['Alex']);
  expect(gates).toEqual([
    {
      consumer: 'CompanyRunner',
      workspace: await realpath(path.join(fixture.company, 'runner-live')),
    },
    { consumer: 'RoleOperator', workspace: await realpath(fixture.workspace) },
  ]);
});

it('fails closed when the narrow role-workspace gate rejects after live Runner admission', async () => {
  const fixture = await lifecycleFixture();
  const active = await launcherManifest(fixture, false);
  const calls: EmployeeIdentity[] = [];
  const consumers: string[] = [];
  await expect(
    launchCompanyRunnerV1({
      manifestPath: active.path,
      authorization: {
        schema_version: '1',
        authorization: 'RED',
        authorized_by: 'Goi',
        task_id: 'TASK-051',
        manifest_sha256: `sha256:${createHash('sha256').update(active.bytes).digest('hex')}`,
      },
      governanceGate: async (_role, _taskId, _workspace, consumer) => {
        consumers.push(consumer);
        if (consumer === 'RoleOperator') throw new Error('role workspace rejected');
      },
      dispatcher: lifecycleDispatcher(calls),
      githubResolver,
    }),
  ).rejects.toThrow('governance integrity gate failed closed');
  expect(consumers).toEqual(['CompanyRunner', 'RoleOperator']);
  expect(calls).toEqual([]);
});

it('launcher resumes a current-state checkpoint and carries it into the later role context', async () => {
  const fixture = await lifecycleFixture();
  const active = await launcherManifest(fixture, false);
  const authorization = {
    schema_version: '1' as const,
    authorization: 'RED' as const,
    authorized_by: 'Goi' as const,
    task_id: 'TASK-051',
    manifest_sha256: `sha256:${createHash('sha256').update(active.bytes).digest('hex')}`,
  };
  const calls: EmployeeIdentity[] = [];
  const packets: Array<Parameters<AgentDispatcher['dispatch']>[0]> = [];
  const delegate = lifecycleDispatcher(calls);
  const dispatcher: AgentDispatcher = {
    dispatch: async (packet, signal) => {
      packets.push(packet);
      return delegate.dispatch(packet, signal);
    },
  };
  const launch = async () =>
    launchCompanyRunnerV1({
      manifestPath: active.path,
      authorization,
      governanceGate: async () => undefined,
      dispatcher,
      githubResolver,
    });
  const activeStore = path.join(fixture.company, 'tasks', 'active');
  await rm(activeStore, { recursive: true, force: true });
  await writeFile(activeStore, 'force a transition-only failure\n');

  await expect(launch()).rejects.toThrow();
  expect(calls).toEqual(['Alex']);
  await rm(activeStore, { force: true });
  await mkdir(activeStore, { recursive: true });

  await expect(launch()).resolves.toMatchObject({ outcome: 'DISPATCHED' });
  expect(calls).toEqual(['Alex']);
  const eventsAfterResume = await new RunnerLedger(
    path.join(fixture.stateDirectory, 'TASK-051.jsonl'),
  ).read();
  expect(eventsAfterResume.some((event) => event.type === 'checkpoint_resume')).toBe(true);

  await expect(launch()).resolves.toMatchObject({
    outcome: 'DISPATCHED',
    decision: { owner: 'Nova' },
  });
  expect(calls).toEqual(['Alex', 'Nova']);
  const novaContextIds = packets[1].context_manifest!.entries.map((entry) => entry.id);
  expect(novaContextIds.some((id) => id.startsWith('checkpoint-'))).toBe(true);
});

it('runs the legal Alex -> Nova -> Pixel PASS -> Atlas APPROVED -> Alex -> COMPLETE path', async () => {
  const fixture = await lifecycleFixture();
  const calls: EmployeeIdentity[] = [];
  let completionVerifications = 0;
  for (let index = 0; index < 7; index++) {
    await expect(
      runCompanyOnce({
        companyRoot: fixture.company,
        taskId: 'TASK-051',
        stateDirectory: fixture.stateDirectory,
        dispatcher: lifecycleDispatcher(calls),
        githubResolver,
        productionContract: contract(fixture, undefined, async (completion) => {
          expect(completion.merge_sha).toBe('c'.repeat(40));
          completionVerifications++;
        }),
      }),
    ).resolves.toMatchObject({ outcome: 'DISPATCHED' });
  }
  const final = await readRunnerTask(fixture.company, 'TASK-051');
  expect(final).toMatchObject({ state: 'COMPLETED', owner: 'Alex', storage: 'completed' });
  expect(calls).toEqual(['Alex', 'Nova', 'Pixel', 'Pixel', 'Atlas', 'Atlas', 'Alex']);
  expect(completionVerifications).toBe(1);
  const events = await new RunnerLedger(path.join(fixture.stateDirectory, 'TASK-051.jsonl')).read();
  expect(events.filter((event) => event.type === 'specialist_checkpoint')).toHaveLength(7);
  expect(events.filter((event) => event.type === 'runner_transition')).toHaveLength(7);
});

it('resumes a valid specialist checkpoint after a transition failure without redispatch', async () => {
  const fixture = await lifecycleFixture();
  const calls: EmployeeIdentity[] = [];
  class FailOnceWriter extends MarkdownRunnerTransitionWriter {
    attempts = 0;
    override async transition(input: Parameters<MarkdownRunnerTransitionWriter['transition']>[0]) {
      this.attempts++;
      if (this.attempts === 1) throw new Error('simulated transition persistence failure');
      return super.transition(input);
    }
  }
  const writer = new FailOnceWriter(fixture.company);
  const options = {
    companyRoot: fixture.company,
    taskId: 'TASK-051',
    stateDirectory: fixture.stateDirectory,
    dispatcher: lifecycleDispatcher(calls),
    githubResolver,
    productionContract: contract(fixture, writer),
  };
  await expect(runCompanyOnce(options)).rejects.toThrow('simulated transition persistence failure');
  await expect(runCompanyOnce(options)).resolves.toMatchObject({ outcome: 'DISPATCHED' });
  expect(calls).toEqual(['Alex']);
  expect((await readRunnerTask(fixture.company, 'TASK-051')).state).toBe('DEVELOPMENT');
  const events = await new RunnerLedger(path.join(fixture.stateDirectory, 'TASK-051.jsonl')).read();
  expect(events.some((event) => event.type === 'checkpoint_resume')).toBe(true);
});

it('fails closed on result identity drift and leaves task state and lease intact', async () => {
  const fixture = await lifecycleFixture();
  const dispatcher: AgentDispatcher = {
    dispatch: async (packet) => ({
      exitCode: 0,
      timedOut: false,
      model: 'bad-fixture',
      inputTokens: 1,
      outputTokens: 1,
      launched: true,
      agentOutcome: 'completed',
      agentResult: {
        ...result('Nova', packet.state, 'DEVELOPMENT', packet.context_manifest!.manifest_sha256),
        role: 'Nova',
      },
    }),
  };
  await expect(
    runCompanyOnce({
      companyRoot: fixture.company,
      taskId: 'TASK-051',
      stateDirectory: fixture.stateDirectory,
      dispatcher,
      githubResolver,
      productionContract: contract(fixture),
    }),
  ).rejects.toThrow(/identity|outcome|context binding/);
  expect((await readRunnerTask(fixture.company, 'TASK-051')).state).toBe('BACKLOG');
  await expect(
    readFile(path.join(fixture.stateDirectory, 'leases', 'TASK-051.lock')),
  ).rejects.toThrow();
});

it('rejects a workspace manifest that overlaps governance protection', async () => {
  const workspace = await root();
  expect(() =>
    validateWorkspaceDescriptorV1(
      {
        ...descriptor(workspace, 'Nova'),
        allowed_paths: ['config/governance-integrity.json'],
      },
      { taskId: 'TASK-051', role: 'Nova' },
    ),
  ).toThrow('overlaps a protected path');
});
