import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { hostname, tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const governanceGateProcess = vi.hoisted(() => ({
  calls: [] as Array<{
    executable: string;
    args: readonly string[];
    options: { cwd?: string; timeout?: number; windowsHide?: boolean };
  }>,
  error: null as Error | null,
  onInvoke: undefined as (() => void) | undefined,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      executable: string,
      args: readonly string[],
      options: { cwd?: string; timeout?: number; windowsHide?: boolean },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (executable !== 'powershell.exe' && executable !== 'pwsh')
        return actual.execFile(executable, [...args], options, callback);
      governanceGateProcess.calls.push({ executable, args: [...args], options });
      governanceGateProcess.onInvoke?.();
      queueMicrotask(() =>
        callback(
          governanceGateProcess.error,
          governanceGateProcess.error ? '' : 'GOVERNANCE INTEGRITY: PASSED',
          governanceGateProcess.error?.message ?? '',
        ),
      );
      return undefined;
    },
  };
});

import {
  EXACT_EXPECTED_EFFECTS,
  EXACT_ROLLBACK,
  EXACT_STOP_CONDITIONS,
  expectedEffectsForAuthorization,
  launchProductionCompanyRunner,
  type ProductionLaunchOptions,
} from '../../scripts/company-runner-production-launcher.js';
import { CliArgsError, parseArgs, validateRunnerCliMode } from '../src/cli.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalConfigPath = path.join(
  repositoryRoot,
  'config/company-runner-v1-task-019-preflight.json',
);
const canonicalOutputSchemaPath = path.join(
  repositoryRoot,
  'docs/schemas/company-runner-codex-output-v1.schema.json',
);
const RUNNER_HEAD = 'b'.repeat(40);
const TARGET_HEAD = '5b5357d3f6359d3df94ed5fe8371750fa34b25e3';
const SENTINEL = 'fake-task-022-credential-never-disclose';
const temporaryDirectories: string[] = [];
const cliBundle = path.join(repositoryRoot, 'dist/cli.js');

const productionCliArguments = [
  '--runner-production-launch',
  '--company-tasks-root',
  'C:\\task-022-company',
  '--runner-preflight-config',
  'C:\\task-022-preflight.json',
  '--runner-authorization',
  'C:\\task-022-authorization.json',
];

interface Fixture {
  root: string;
  configPath: string;
  authorizationPath: string;
  config: Record<string, unknown>;
  authorization: Record<string, unknown>;
  stateDirectory: string;
  stopFile: string;
  taskPath: string;
}

interface FixtureOptions {
  state?: 'READY_FOR_QA' | 'QA' | 'QA_RETEST' | 'READY_FOR_REVIEW' | 'REVIEW' | 'APPROVED';
  owner?: 'Pixel' | 'Atlas' | 'Alex';
  draft?: boolean;
  inlineEvidence?: boolean;
  head?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'task-022-launcher-'));
  temporaryDirectories.push(root);
  await Promise.all(
    ['backlog', 'active', 'review', 'completed'].map((store) =>
      mkdir(path.join(root, 'tasks', store), { recursive: true }),
    ),
  );
  await Promise.all([
    mkdir(path.join(root, 'scripts'), { recursive: true }),
    mkdir(path.join(root, 'config'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(root, 'scripts', 'Test-GovernanceIntegrity.ps1'),
      '# Test-only shared-gate path sentinel.\n',
    ),
    writeFile(path.join(root, 'config', 'governance-integrity.json'), '{}\n'),
  ]);
  await mkdir(path.join(root, 'documentation', 'qa'), { recursive: true });
  const outputSchemaPath = path.join(
    root,
    'docs/schemas/company-runner-codex-output-v1.schema.json',
  );
  await mkdir(path.dirname(outputSchemaPath), { recursive: true });
  await writeFile(outputSchemaPath, await readFile(canonicalOutputSchemaPath, 'utf8'));
  await writeFile(
    path.join(path.dirname(outputSchemaPath), 'company-runner-approval-v1.schema.json'),
    await readFile(
      path.join(repositoryRoot, 'docs/schemas/company-runner-approval-v1.schema.json'),
      'utf8',
    ),
  );
  const taskPath = path.join(root, 'tasks', 'review', 'task-020.md');
  const state = options.state ?? 'READY_FOR_QA';
  const owner = options.owner ?? 'Pixel';
  const head = options.head ?? TARGET_HEAD;
  const linkedEvidence = options.inlineEvidence
    ? ''
    : '- **Evidence link:** `documentation/qa/task-020-fixture.md`';
  const inlineEvidence = options.inlineEvidence
    ? `## Implementation Evidence

- **Change set/version:** Fixture delivery
- **Feature branch:** task/TASK-020-reconcile-company-runner-roadmap
- **Commit SHA:** ${head}
- **Pull Request URL/number:** PR #4
- **Summary:** Complete fixture implementation.
- **Files changed:** COMPANY-MEMORY.md; memory/project-history.md; projects/codex-pixel-agents-integration/PROJECT.md
- **Decisions and assumptions:** Exact fixture scope only.
- **Tests added or changed:** Focused fixture checks.
- **Verification and results:** All focused checks passed.
- **Known risks or limitations:** None
- **Evidence links:** Issue #3; PR #4
`
    : '';
  const taskBytes = `# TASK-020
- **Task ID:** TASK-020
- **Owner:** ${owner}
- **Current state:** ${state}
- **Resume state (required only when BLOCKED):** None
- **Repository:** goikl2010-png/AI-Company
- **GitHub Issue URL/number:** Issue #3
- **Pull Request URL/number:** PR #4
- **Base branch:** main
- **Feature branch:** task/TASK-020-reconcile-company-runner-roadmap
- **Current PR head commit:** ${head}
${linkedEvidence}

${inlineEvidence}
`;
  await writeFile(taskPath, taskBytes);
  await writeFile(
    path.join(root, 'documentation', 'qa', 'task-020-fixture.md'),
    `Pixel PASSED fixture evidence for ${head}.\n`,
  );
  const canonical = JSON.parse(await readFile(canonicalConfigPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const stateDirectory = path.join(root, '.runner');
  const stopFile = path.join(stateDirectory, 'STOP');
  const config: Record<string, unknown> = {
    ...canonical,
    target_path: taskPath,
    target_sha256:
      state === 'READY_FOR_QA' && owner === 'Pixel' ? sha256(taskBytes) : canonical.target_sha256,
    target_head: TARGET_HEAD,
    executable: path.join(root, 'codex.cmd'),
    approved_working_root: root,
    output_schema: outputSchemaPath,
    state_directory: stateDirectory,
    stop_file: stopFile,
    argument_template: [
      '--ask-for-approval',
      'on-request',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--cd',
      root,
      '--output-schema',
      outputSchemaPath,
      '<JSON_HANDOFF_PACKET>',
    ],
  };
  const configPath = path.join(root, 'preflight.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const authorization = {
    schema_version: '1',
    authorization: 'RED',
    authorized_by: 'Goi',
    task_id: 'TASK-020',
    target_state: state,
    target_owner: owner,
    target_sha256: sha256(taskBytes),
    github: {
      repository: config.target_repository,
      issue: config.target_issue,
      issueState: 'OPEN',
      pr: config.target_pr,
      prState: 'OPEN',
      draft: options.draft ?? false,
      base: 'main',
      branch: 'task/TASK-020-reconcile-company-runner-roadmap',
      head,
      scope: {
        commits: 1,
        additions: 83,
        deletions: 0,
        changedFiles: 3,
        files: [
          {
            path: 'COMPANY-MEMORY.md',
            status: 'modified',
            additions: 30,
            deletions: 0,
            changes: 30,
          },
          {
            path: 'memory/project-history.md',
            status: 'modified',
            additions: 28,
            deletions: 0,
            changes: 28,
          },
          {
            path: 'projects/codex-pixel-agents-integration/PROJECT.md',
            status: 'added',
            additions: 25,
            deletions: 0,
            changes: 25,
          },
        ],
      },
    },
    configuration_sha256: sha256(`${JSON.stringify(config, null, 2)}\n`),
    runner_commit: RUNNER_HEAD,
    executable: config.executable,
    codex_version: config.codex_version,
    approved_working_root: config.approved_working_root,
    output_schema: config.output_schema,
    argument_template: config.argument_template,
    credential_environment_variable: 'GH_TOKEN',
    max_dispatches: 1,
    expected_effects: [...expectedEffectsForAuthorization(state, owner)],
    rollback: EXACT_ROLLBACK,
    timeout_ms: config.timeout_ms,
    stop_conditions: [...EXACT_STOP_CONDITIONS],
  };
  const authorizationPath = path.join(root, 'authorization.json');
  await writeFile(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`);
  return {
    root,
    configPath,
    authorizationPath,
    config,
    authorization,
    stateDirectory,
    stopFile,
    taskPath,
  };
}

async function rewriteAuthorization(candidate: Fixture, authorization: unknown): Promise<void> {
  await writeFile(candidate.authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`);
}

function seams(candidate: Fixture, counters: { github: number; spawn: number }) {
  const options: ProductionLaunchOptions = {
    configPath: candidate.configPath,
    authorizationPath: candidate.authorizationPath,
    companyRoot: candidate.root,
    parentEnvironment: { GH_TOKEN: SENTINEL, PATH: process.env.PATH },
    checkoutProbe: async (checkoutRoot) => ({
      root: checkoutRoot,
      head: RUNNER_HEAD,
      dirty: false,
    }),
    versionProbe: async (_executable, environment) => {
      expect(environment.GH_TOKEN).toBeUndefined();
      return 'codex-cli 0.150.1';
    },
    globalCapabilityProbe: async () =>
      '-a, --ask-for-approval <APPROVAL_POLICY>\n- on-request: Ask when requested',
    capabilityProbe: async () =>
      '--json\n--output-schema <FILE>\n--cd <DIR>\n--sandbox <SANDBOX_MODE>',
    githubRun: async (_executable, args, environment) => {
      counters.github++;
      expect(environment.GH_TOKEN).toBe(SENTINEL);
      if (args[1] === 'user') return { login: 'goikl2010-png' };
      if (args[1] === 'repos/goikl2010-png/AI-Company')
        return { full_name: 'goikl2010-png/AI-Company' };
      if (args[1].includes('/files?'))
        return (
          candidate.authorization.github as {
            scope: { files: Array<Record<string, unknown>> };
          }
        ).scope.files.map(({ path: filename, ...file }) => ({ filename, ...file }));
      return args[1].includes('/issues/')
        ? { state: 'open' }
        : {
            state: 'open',
            draft: (candidate.authorization.github as { draft: boolean }).draft,
            merged_at: null,
            commits: 1,
            additions: 83,
            deletions: 0,
            changed_files: 3,
            base: { ref: 'main' },
            head: {
              ref: 'task/TASK-020-reconcile-company-runner-roadmap',
              sha: (candidate.authorization.github as { head: string }).head,
            },
          };
    },
    spawnProcess: async (_executable, args, cwd, timeout, _signal, environment) => {
      counters.spawn++;
      expect(args).toEqual([
        '--ask-for-approval',
        'on-request',
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--cd',
        cwd,
        '--output-schema',
        path.join(cwd, 'docs/schemas/company-runner-codex-output-v1.schema.json'),
        expect.any(String),
      ]);
      expect(timeout).toBe(120_000);
      expect(environment.GH_TOKEN).toBe(SENTINEL);
      expect(JSON.stringify(args)).not.toContain(SENTINEL);
      return {
        exitCode: 0,
        timedOut: false,
        model: 'fake-process-seam',
        inputTokens: 0,
        outputTokens: 0,
        launched: true,
        output: `${JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({ outcome: 'completed' }),
          },
        })}\n`,
      };
    },
  };
  return options;
}

async function stoppedByCanonicalWindowsPathGate(
  options: ProductionLaunchOptions,
  counters: { github: number; spawn: number },
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  await expect(launchProductionCompanyRunner(options)).rejects.toThrow('absolute Windows path');
  expect(counters).toEqual({ github: 0, spawn: 0 });
  return true;
}

beforeEach(() => {
  governanceGateProcess.calls.splice(0);
  governanceGateProcess.error = null;
  governanceGateProcess.onInvoke = undefined;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('production Company Runner CLI mode boundary', () => {
  const safeModeCombinations = [
    ['--runner-fake'],
    ['--runner-dry-run'],
    ['--runner-status'],
    ['--runner-fake', '--runner-dry-run'],
    ['--runner-fake', '--runner-status'],
    ['--runner-dry-run', '--runner-status'],
    ['--runner-fake', '--runner-dry-run', '--runner-status'],
  ];

  it.each(safeModeCombinations)(
    'fails closed before production dispatch for safe-mode/status combination %j',
    (...conflictingFlags) => {
      const args = parseArgs([...productionCliArguments, ...conflictingFlags]);

      expect(() => validateRunnerCliMode(args)).toThrow(CliArgsError);
      expect(() => validateRunnerCliMode(args)).toThrow(
        '--runner-production-launch cannot be combined with legacy Runner options',
      );
    },
  );

  it.each([
    ['--runner-task', 'TASK-020'],
    ['--runner-state-directory', 'C:\\task-022-runner-state'],
    ['--runner-task', 'TASK-020', '--runner-state-directory', 'C:\\task-022-runner-state'],
  ])('rejects production mixed with legacy Runner operation %j', (...legacyArguments) => {
    const args = parseArgs([...productionCliArguments, ...legacyArguments]);

    expect(() => validateRunnerCliMode(args)).toThrow(CliArgsError);
    expect(() => validateRunnerCliMode(args)).toThrow(
      '--runner-production-launch cannot be combined with legacy Runner options',
    );
  });

  it.each([
    ['--runner-preflight-config', 'C:\\task-022-preflight.json'],
    ['--runner-authorization', 'C:\\task-022-authorization.json'],
    [
      '--runner-preflight-config',
      'C:\\task-022-preflight.json',
      '--runner-authorization',
      'C:\\task-022-authorization.json',
    ],
  ])('rejects production-only input without the production selector %j', (...productionInputs) => {
    const args = parseArgs(productionInputs);

    expect(() => validateRunnerCliMode(args)).toThrow(CliArgsError);
    expect(() => validateRunnerCliMode(args)).toThrow('require --runner-production-launch');
  });

  it('preserves the unambiguous production launch path', () => {
    expect(() => validateRunnerCliMode(parseArgs(productionCliArguments))).not.toThrow();
  });

  it('exits nonzero before authorization or dispatch for every conflicting CLI mode', () => {
    if (!existsSync(cliBundle)) return;
    const conflictingArgumentSets = [
      ...safeModeCombinations,
      ['--runner-task', 'TASK-020'],
      ['--runner-state-directory', 'C:\\task-022-runner-state'],
      ['--runner-task', 'TASK-020', '--runner-state-directory', 'C:\\task-022-runner-state'],
    ];

    for (const conflictingArguments of conflictingArgumentSets) {
      const result = spawnSync(
        process.execPath,
        [cliBundle, ...productionCliArguments, ...conflictingArguments],
        { encoding: 'utf8', timeout: 5_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        '--runner-production-launch cannot be combined with legacy Runner options',
      );
      expect(result.stderr).not.toContain('Production launch failed closed');
    }

    for (const productionInputs of [
      ['--runner-preflight-config', 'C:\\task-022-preflight.json'],
      ['--runner-authorization', 'C:\\task-022-authorization.json'],
      [
        '--runner-preflight-config',
        'C:\\task-022-preflight.json',
        '--runner-authorization',
        'C:\\task-022-authorization.json',
      ],
    ]) {
      const result = spawnSync(process.execPath, [cliBundle, ...productionInputs], {
        encoding: 'utf8',
        timeout: 5_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('require --runner-production-launch');
    }
  }, 15_000);

  it('routes production CLI execution through the single shared-gate-protected launcher', async () => {
    const [cliSource, launcherSource] = await Promise.all([
      readFile(path.join(repositoryRoot, 'server/src/cli.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/company-runner-production-launcher.ts'), 'utf8'),
    ]);
    const productionCall = cliSource.indexOf('await launchProductionCompanyRunner({');
    expect(productionCall).toBeGreaterThan(0);
    expect(cliSource.indexOf('runCompanyOnce({', productionCall)).toBe(-1);
    const gateCall = launcherSource.indexOf(
      'await enforceSharedGovernanceIntegrityGate(options.companyRoot, config);',
    );
    const authorizationRead = launcherSource.indexOf(
      'const authorization = await readJson(options.authorizationPath);',
    );
    expect(gateCall).toBeGreaterThan(0);
    expect(gateCall).toBeLessThan(authorizationRead);
  });
});

describe('production Company Runner launcher', () => {
  it('invokes the existing shared gate exactly once before governed execution', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    governanceGateProcess.onInvoke = () => {
      expect(counters).toEqual({ github: 0, spawn: 0 });
      expect(existsSync(candidate.stateDirectory)).toBe(false);
    };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) {
      expect(governanceGateProcess.calls).toHaveLength(1);
      return;
    }
    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'DISPATCHED',
    });
    expect(governanceGateProcess.calls).toEqual([
      {
        executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(candidate.root, 'scripts', 'Test-GovernanceIntegrity.ps1'),
          '-ManifestPath',
          path.join(candidate.root, 'config', 'governance-integrity.json'),
          '-Role',
          'Pixel',
          '-Operation',
          'Admission',
          '-TaskId',
          'TASK-020',
          '-WorktreePath',
          repositoryRoot,
          '-Consumer',
          'CompanyRunner',
        ],
        options: { cwd: candidate.root, timeout: 30_000, windowsHide: true },
      },
    ]);
  });

  it.each([
    ['nonzero verifier result', Object.assign(new Error('gate exited 1'), { code: 1 })],
    ['verifier exception', new Error('gate process failed')],
    ['verifier timeout', Object.assign(new Error('gate timed out'), { killed: true })],
  ])('fails closed on %s before any governed execution', async (_label, gateError) => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    governanceGateProcess.error = gateError;
    await expect(launchProductionCompanyRunner(seams(candidate, counters))).rejects.toThrow(
      'Shared governance integrity gate failed closed.',
    );
    expect(governanceGateProcess.calls).toHaveLength(1);
    expect(counters).toEqual({ github: 0, spawn: 0 });
    expect(existsSync(candidate.stateDirectory)).toBe(false);
  });

  it.each([
    ['verifier', 'scripts/Test-GovernanceIntegrity.ps1'],
    ['manifest', 'config/governance-integrity.json'],
  ])('fails closed when the shared %s is missing', async (_label, relativePath) => {
    const candidate = await fixture();
    await rm(path.join(candidate.root, ...relativePath.split('/')));
    const counters = { github: 0, spawn: 0 };
    await expect(launchProductionCompanyRunner(seams(candidate, counters))).rejects.toThrow(
      'Shared governance integrity gate failed closed.',
    );
    expect(governanceGateProcess.calls).toHaveLength(0);
    expect(counters).toEqual({ github: 0, spawn: 0 });
    expect(existsSync(candidate.stateDirectory)).toBe(false);
  });

  it('constructs the real dispatcher and reaches exactly one governed fake process spawn', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    const result = await launchProductionCompanyRunner(options);
    expect(result.outcome).toBe('DISPATCHED');
    expect(counters.github).toBe(10);
    expect(counters.spawn).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    const source = await readFile(
      path.join(repositoryRoot, 'scripts/company-runner-production-launcher.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/dispatcher\??\s*:/);
    expect(source).not.toContain('FakeAgentDispatcher');
  });

  it.each([
    ['READY_FOR_QA', 'Pixel'],
    ['QA', 'Pixel'],
    ['QA_RETEST', 'Pixel'],
    ['READY_FOR_REVIEW', 'Atlas'],
    ['REVIEW', 'Atlas'],
  ] as const)('permits exactly one fresh %s / %s dispatch', async (state, owner) => {
    const candidate = await fixture({
      state,
      owner,
      ...(state === 'QA_RETEST' ? { head: 'c'.repeat(40) } : {}),
    });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'DISPATCHED',
      decision: { state, owner, action_kind: 'DISPATCH_ROLE', classification: 'GREEN' },
    });
    if (state !== 'READY_FOR_QA')
      expect(candidate.authorization.target_sha256).not.toBe(candidate.config.target_sha256);
    expect(counters).toEqual({ github: 10, spawn: 1 });
  });

  it('accepts an exactly authorized live draft and complete inline TASK-020 evidence', async () => {
    const candidate = await fixture({ draft: true, inlineEvidence: true });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'DISPATCHED',
      decision: { github: { draft: true } },
    });
    expect(counters).toEqual({ github: 10, spawn: 1 });
  });

  it('emits the exact APPROVED / Alex RED stop package without launching an agent', async () => {
    const candidate = await fixture({ state: 'APPROVED', owner: 'Alex', draft: true });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'APPROVAL_REQUIRED',
      decision: {
        state: 'APPROVED',
        owner: 'Alex',
        action_kind: 'AWAIT_ALEX_DECISION',
        classification: 'RED',
      },
      approval: {
        agent: 'Alex',
        workflow_state: 'APPROVED',
        requested_action: 'AWAIT_ALEX_DECISION',
        risk_approval_class: 'RED',
      },
    });
    expect(counters).toEqual({ github: 10, spawn: 0 });
  });

  it.each([
    ['CHANGES_REQUIRED', 'Nova'],
    ['BLOCKED', 'Alex'],
    ['COMPLETED', 'Alex'],
    ['QA', 'Atlas'],
    ['REVIEW', 'Pixel'],
    ['APPROVED', 'Pixel'],
  ])('rejects unauthorized or wrong-role %s / %s with zero launch', async (state, owner) => {
    const candidate = await fixture();
    await rewriteAuthorization(candidate, {
      ...candidate.authorization,
      target_state: state,
      target_owner: owner,
    });
    const counters = { github: 0, spawn: 0 };

    await expect(launchProductionCompanyRunner(seams(candidate, counters))).rejects.toThrow();
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it('rejects stale state authorization before GitHub or process launch', async () => {
    const candidate = await fixture({ state: 'QA', owner: 'Pixel' });
    await rewriteAuthorization(candidate, {
      ...candidate.authorization,
      target_state: 'READY_FOR_QA',
      expected_effects: [...expectedEffectsForAuthorization('READY_FOR_QA', 'Pixel')],
    });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).rejects.toThrow(
      /target identity|fingerprint/i,
    );
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it.each([
    [
      'missing draft',
      (github: Record<string, unknown>) => {
        const { draft: _draft, ...withoutDraft } = github;
        return withoutDraft;
      },
    ],
    ['non-boolean draft', (github: Record<string, unknown>) => ({ ...github, draft: 'true' })],
  ])('rejects %s before GitHub or process launch', async (_name, mutateGithub) => {
    const candidate = await fixture();
    await rewriteAuthorization(candidate, {
      ...candidate.authorization,
      github: mutateGithub(candidate.authorization.github as Record<string, unknown>),
    });
    const counters = { github: 0, spawn: 0 };

    await expect(launchProductionCompanyRunner(seams(candidate, counters))).rejects.toThrow();
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it.each(['draft', 'scope'] as const)(
    'rejects missing live GitHub %s facts with zero launch',
    async (missing) => {
      const candidate = await fixture();
      const counters = { github: 0, spawn: 0 };
      const options = seams(candidate, counters);
      const validRun = options.githubRun!;
      options.githubRun = async (executable, args, environment, signal) => {
        const result = await validRun(executable, args, environment, signal);
        if (!args[1].includes('/pulls/') || args[1].includes('/files?'))
          return missing === 'scope' && args[1].includes('/files?') ? [] : result;
        if (missing === 'draft') {
          const { draft: _draft, ...withoutDraft } = result as Record<string, unknown>;
          return withoutDraft;
        }
        const { changed_files: _changedFiles, ...withoutScopeCount } = result as Record<
          string,
          unknown
        >;
        return withoutScopeCount;
      };
      if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

      await expect(launchProductionCompanyRunner(options)).rejects.toThrow('failed closed');
      expect(counters.spawn).toBe(0);
    },
  );

  it('rejects authorized draft drift against freshly fetched GitHub facts with zero launch', async () => {
    const candidate = await fixture();
    await rewriteAuthorization(candidate, {
      ...candidate.authorization,
      github: { ...(candidate.authorization.github as object), draft: true },
    });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).rejects.toThrow('failed closed');
    expect(counters.spawn).toBe(0);
    expect(counters.github).toBeGreaterThan(0);
  });

  it('rejects authorized PR scope drift against freshly fetched facts with zero launch', async () => {
    const candidate = await fixture();
    const github = structuredClone(candidate.authorization.github as Record<string, unknown>);
    const scope = github.scope as {
      additions: number;
      files: Array<{ additions: number; changes: number }>;
    };
    scope.additions++;
    scope.files[0].additions++;
    scope.files[0].changes++;
    await rewriteAuthorization(candidate, { ...candidate.authorization, github });
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;

    await expect(launchProductionCompanyRunner(options)).rejects.toThrow('failed closed');
    expect(counters.spawn).toBe(0);
    expect(counters.github).toBeGreaterThan(0);
  });

  it.each([
    ['unknown top-level key', (auth: Record<string, unknown>) => ({ ...auth, extra: 'x' })],
    [
      'unknown nested GitHub key',
      (auth: Record<string, unknown>) => ({
        ...auth,
        github: { ...(auth.github as object), extra: 'x' },
      }),
    ],
    [
      'credential-like unknown field',
      (auth: Record<string, unknown>) => ({ ...auth, token: SENTINEL }),
    ],
    [
      'credential-like content',
      (auth: Record<string, unknown>) => ({ ...auth, rollback: `token=${'x'.repeat(24)}` }),
    ],
    ['empty effects', (auth: Record<string, unknown>) => ({ ...auth, expected_effects: [] })],
    ['malformed effects', (auth: Record<string, unknown>) => ({ ...auth, expected_effects: [''] })],
    [
      'duplicate effects',
      (auth: Record<string, unknown>) => ({
        ...auth,
        expected_effects: [EXACT_EXPECTED_EFFECTS[0], EXACT_EXPECTED_EFFECTS[0]],
      }),
    ],
    [
      'scope-drifted effects',
      (auth: Record<string, unknown>) => ({ ...auth, expected_effects: ['Dispatch any task.'] }),
    ],
    ['empty rollback', (auth: Record<string, unknown>) => ({ ...auth, rollback: '' })],
    [
      'overbroad rollback',
      (auth: Record<string, unknown>) => ({ ...auth, rollback: 'Continue automatically.' }),
    ],
    [
      'empty stop conditions',
      (auth: Record<string, unknown>) => ({ ...auth, stop_conditions: [] }),
    ],
    [
      'malformed stop conditions',
      (auth: Record<string, unknown>) => ({ ...auth, stop_conditions: [1] }),
    ],
    [
      'duplicate stop conditions',
      (auth: Record<string, unknown>) => ({
        ...auth,
        stop_conditions: [EXACT_STOP_CONDITIONS[0], EXACT_STOP_CONDITIONS[0]],
      }),
    ],
    [
      'scope-drifted stop conditions',
      (auth: Record<string, unknown>) => ({
        ...auth,
        stop_conditions: ['Stop only after deployment.'],
      }),
    ],
  ])('rejects %s with zero GitHub and process calls', async (_name, mutate) => {
    const candidate = await fixture();
    await rewriteAuthorization(candidate, mutate(candidate.authorization));
    const counters = { github: 0, spawn: 0 };
    await expect(launchProductionCompanyRunner(seams(candidate, counters))).rejects.toThrow();
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it.each([
    ['dirty checkout', { root: repositoryRoot, head: RUNNER_HEAD, dirty: true }],
    ['stale checkout', { root: repositoryRoot, head: 'c'.repeat(40), dirty: false }],
    [
      'ambiguous head',
      { root: repositoryRoot, head: `${RUNNER_HEAD}\n${'c'.repeat(40)}`, dirty: false },
    ],
    [
      'wrong checkout root',
      { root: path.dirname(repositoryRoot), head: RUNNER_HEAD, dirty: false },
    ],
  ])('rejects %s before GitHub or process launch', async (_name, provenance) => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    options.checkoutProbe = async (checkoutRoot) => ({
      ...provenance,
      root: provenance.root === repositoryRoot ? checkoutRoot : provenance.root,
    });
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    await expect(launchProductionCompanyRunner(options)).rejects.toThrow(/checkout/i);
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it('rejects unavailable checkout provenance before GitHub or process launch', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    options.checkoutProbe = async () => {
      throw new Error('unavailable');
    };
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    await expect(launchProductionCompanyRunner(options)).rejects.toThrow('unavailable');
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it.each([
    'codex-cli 0.148.0',
    'codex-cli 0.149.0',
    'codex-cli 0.150.0',
    'codex-cli 0.150.2',
    '',
    'ambiguous\ncodex-cli 0.150.1',
  ])('rejects installed version drift %j before GitHub or process launch', async (version) => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    options.versionProbe = async () => version;
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    await expect(launchProductionCompanyRunner(options)).rejects.toThrow('exact authorization');
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it('stops on the checked-in stop signal with zero spawn', async () => {
    const candidate = await fixture();
    await mkdir(candidate.stateDirectory, { recursive: true });
    await writeFile(candidate.stopFile, 'stop\n');
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    const result = await launchProductionCompanyRunner(options);
    expect(result.outcome).toBe('STOPPED');
    expect(counters).toEqual({ github: 0, spawn: 0 });
  });

  it('honors lease contention with zero spawn', async () => {
    const candidate = await fixture();
    const leaseDirectory = path.join(candidate.stateDirectory, 'leases');
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(
      path.join(leaseDirectory, 'TASK-020.lock'),
      JSON.stringify({
        task_id: 'TASK-020',
        run_id: 'other-run',
        dispatch_id: 'sha256:other',
        pid: process.pid,
        host: hostname(),
        acquired_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        state_fingerprint: 'sha256:other',
      }),
    );
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    const result = await launchProductionCompanyRunner(options);
    expect(result.outcome).toBe('LEASE_CONTENDED');
    expect(counters.spawn).toBe(0);
  });

  it('deduplicates a completed dispatch and does not spawn again', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'DISPATCHED',
    });
    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'NO_ACTION_UNCHANGED',
    });
    expect(counters.spawn).toBe(1);
  });

  it('requires recovery after an ambiguous failed spawn and never respawns', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    options.spawnProcess = async () => {
      counters.spawn++;
      throw new Error('ambiguous process boundary');
    };
    await expect(launchProductionCompanyRunner(options)).rejects.toThrow('failed closed');
    expect(counters.spawn).toBe(1);
    await expect(launchProductionCompanyRunner(options)).resolves.toMatchObject({
      outcome: 'RECOVERY_REQUIRED',
    });
    expect(counters.spawn).toBe(1);
  });
});
