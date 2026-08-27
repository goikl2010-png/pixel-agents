import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { hostname, tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXACT_EXPECTED_EFFECTS,
  EXACT_ROLLBACK,
  EXACT_STOP_CONDITIONS,
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
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'task-022-launcher-'));
  temporaryDirectories.push(root);
  await Promise.all(
    ['backlog', 'active', 'review', 'completed'].map((store) =>
      mkdir(path.join(root, 'tasks', store), { recursive: true }),
    ),
  );
  await mkdir(path.join(root, 'documentation', 'qa'), { recursive: true });
  const outputSchemaPath = path.join(
    root,
    'docs/schemas/company-runner-codex-output-v1.schema.json',
  );
  await mkdir(path.dirname(outputSchemaPath), { recursive: true });
  await writeFile(outputSchemaPath, await readFile(canonicalOutputSchemaPath, 'utf8'));
  const taskPath = path.join(root, 'tasks', 'review', 'task-020.md');
  const taskBytes = `# TASK-020
- **Task ID:** TASK-020
- **Owner:** Pixel
- **Current state:** READY_FOR_QA
- **Resume state (required only when BLOCKED):** None
- **Repository:** goikl2010-png/AI-Company
- **GitHub Issue URL/number:** Issue #3
- **Pull Request URL/number:** PR #4
- **Base branch:** main
- **Feature branch:** task/TASK-020-reconcile-company-runner-roadmap
- **Current PR head commit:** ${TARGET_HEAD}
- **Evidence link:** \`documentation/qa/task-020-fixture.md\`
`;
  await writeFile(taskPath, taskBytes);
  await writeFile(
    path.join(root, 'documentation', 'qa', 'task-020-fixture.md'),
    `Disposable launcher fixture only; no TASK-020 QA. Head ${TARGET_HEAD}.\n`,
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
    target_sha256: sha256(taskBytes),
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
    target_state: 'READY_FOR_QA',
    target_owner: 'Pixel',
    target_sha256: config.target_sha256,
    github: {
      repository: config.target_repository,
      issue: config.target_issue,
      issueState: 'OPEN',
      pr: config.target_pr,
      prState: 'OPEN',
      draft: false,
      base: 'main',
      branch: 'task/TASK-020-reconcile-company-runner-roadmap',
      head: config.target_head,
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
    expected_effects: [...EXACT_EXPECTED_EFFECTS],
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
      return 'codex-cli 0.149.0';
    },
    globalCapabilityProbe: async () =>
      '-a, --ask-for-approval <APPROVAL_POLICY>\n- on-request: Ask when requested',
    capabilityProbe: async () =>
      '--json\n--output-schema <FILE>\n--cd <DIR>\n--sandbox <SANDBOX_MODE>',
    githubRun: async (_executable, args, environment) => {
      counters.github++;
      expect(environment.GH_TOKEN).toBe(SENTINEL);
      return args[1].includes('/issues/')
        ? { state: 'open' }
        : {
            state: 'open',
            draft: false,
            merged_at: null,
            base: { ref: 'main' },
            head: {
              ref: 'task/TASK-020-reconcile-company-runner-roadmap',
              sha: TARGET_HEAD,
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
});

describe('production Company Runner launcher', () => {
  it('constructs the real dispatcher and reaches exactly one governed fake process spawn', async () => {
    const candidate = await fixture();
    const counters = { github: 0, spawn: 0 };
    const options = seams(candidate, counters);
    if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
    const result = await launchProductionCompanyRunner(options);
    expect(result.outcome).toBe('DISPATCHED');
    expect(counters.github).toBe(4);
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

  it.each(['codex-cli 0.148.0', 'codex-cli 0.150.0', '', 'ambiguous\ncodex-cli 0.149.0'])(
    'rejects installed version drift %j before GitHub or process launch',
    async (version) => {
      const candidate = await fixture();
      const counters = { github: 0, spawn: 0 };
      const options = seams(candidate, counters);
      options.versionProbe = async () => version;
      if (await stoppedByCanonicalWindowsPathGate(options, counters)) return;
      await expect(launchProductionCompanyRunner(options)).rejects.toThrow('exact authorization');
      expect(counters).toEqual({ github: 0, spawn: 0 });
    },
  );

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
