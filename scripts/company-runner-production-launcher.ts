import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { access, readFile } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import {
  buildGovernedChildEnvironment,
  CodexAgentDispatcher,
  GhCliGitHubFactResolver,
  type GitHubFacts,
  type GitHubPullRequestScope,
  readRunnerTask,
  runCompanyOnce,
  type RunOnceResult,
} from '../server/src/companyRunner.js';
import {
  productionConfigurationSha256,
  type ProductionRunnerConfig,
  validateProductionRunnerConfig,
} from './company-runner-task-019-preflight.js';

export interface GoiRedLaunchAuthorization {
  schema_version: '1' | '2';
  authorization: 'RED';
  authorized_by: 'Goi';
  task_id: string;
  target_state: AuthorizedTargetState;
  target_owner: AuthorizedTargetOwner;
  target_sha256: string;
  github: GitHubFacts & { scope: GitHubPullRequestScope };
  configuration_sha256: string;
  runner_commit: string;
  executable: string;
  codex_version: 'codex-cli 0.150.1' | 'codex-cli 0.152.1';
  approved_working_root: string;
  output_schema: string;
  argument_template: string[];
  credential_environment_variable: 'GH_TOKEN';
  max_dispatches: 1;
  expected_effects: string[];
  rollback: string;
  timeout_ms: number;
  stop_conditions: string[];
}

export interface ProductionLaunchOptions {
  configPath: string;
  authorizationPath: string;
  companyRoot: string;
  parentEnvironment?: NodeJS.ProcessEnv;
  githubRun?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<unknown>;
  versionProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  codexAuthenticationProbe?: (
    executable: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<string>;
  globalCapabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  capabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  spawnProcess?: ConstructorParameters<typeof CodexAgentDispatcher>[0]['spawnProcess'];
  checkoutProbe?: (checkoutRoot: string) => Promise<RunnerCheckoutProvenance>;
}

export interface RunnerCheckoutProvenance {
  root: string;
  head: string;
  dirty: boolean;
}

export interface SanitizedProductionLaunchResult {
  run_id: string;
  outcome: RunOnceResult['outcome'];
  decision: Omit<RunOnceResult['decision'], 'github'> & { github?: GitHubFacts };
  dispatch?: Omit<NonNullable<RunOnceResult['dispatch']>, 'output'>;
  approval?: RunOnceResult['approval'];
}

type AuthorizedTargetState =
  'READY_FOR_QA' | 'QA' | 'QA_RETEST' | 'READY_FOR_REVIEW' | 'REVIEW' | 'APPROVED';
type AuthorizedTargetOwner = 'Pixel' | 'Atlas' | 'Alex';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const AUTHORIZATION_KEYS = [
  'schema_version',
  'authorization',
  'authorized_by',
  'task_id',
  'target_state',
  'target_owner',
  'target_sha256',
  'github',
  'configuration_sha256',
  'runner_commit',
  'executable',
  'codex_version',
  'approved_working_root',
  'output_schema',
  'argument_template',
  'credential_environment_variable',
  'max_dispatches',
  'expected_effects',
  'rollback',
  'timeout_ms',
  'stop_conditions',
] as const;
const GITHUB_KEYS = [
  'repository',
  'issue',
  'issueState',
  'pr',
  'prState',
  'draft',
  'base',
  'branch',
  'head',
  'scope',
] as const;
const GITHUB_SCOPE_KEYS = ['commits', 'additions', 'deletions', 'changedFiles', 'files'] as const;
const GITHUB_FILE_KEYS = ['path', 'status', 'additions', 'deletions', 'changes'] as const;
const HISTORICAL_TASK020_FILES = [
  'COMPANY-MEMORY.md',
  'memory/project-history.md',
  'projects/codex-pixel-agents-integration/PROJECT.md',
] as const;
export const EXACT_EXPECTED_EFFECTS = [
  'Dispatch Pixel exactly once for authorized TASK-020 QA at READY_FOR_QA.',
  'Permit only Pixel-owned TASK-020 QA evidence and legal task handoff updates.',
] as const;
export function expectedEffectsForAuthorization(
  state: AuthorizedTargetState,
  owner: AuthorizedTargetOwner,
  taskId = 'TASK-020',
): readonly string[] {
  if (state === 'READY_FOR_QA' && owner === 'Pixel')
    return [
      `Dispatch Pixel exactly once for authorized ${taskId} QA at READY_FOR_QA.`,
      `Permit only Pixel-owned ${taskId} QA evidence and legal task handoff updates.`,
    ];
  if (state === 'APPROVED' && owner === 'Alex')
    return [
      `Launch no agent for ${taskId} at APPROVED / Alex.`,
      'Emit only the exact owner/RED stop package; merge, closure, deployment, and completion remain forbidden.',
    ];
  return [
    `Dispatch ${owner} exactly once for authorized ${taskId} ${state} role-owned work.`,
    `Permit only ${owner}-owned ${taskId} evidence and legal task handoff updates from ${state}.`,
  ];
}
export const EXACT_ROLLBACK =
  'Stop the one-shot Runner, preserve audit evidence, and do not redispatch after ambiguity.';
export const EXACT_STOP_CONDITIONS = [
  'Any authorization, configuration, target, checkout, GitHub, or credential drift.',
  'Any Codex executable, version, capability, root, schema, or argument drift.',
  'Any lease, recovery, deduplication, circuit, heartbeat, timeout, or stop signal.',
] as const;
const CREDENTIAL_CONTENT =
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|bearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----|(?:password|secret|token|private[_ -]?key)\s*[:=]\s*\S+)/i;
const execFileAsync = promisify(execFile);
const runnerCheckoutRoot = path.resolve(__dirname, '..');
const GOVERNANCE_INTEGRITY_TIMEOUT_MS = 30_000;

async function enforceSharedGovernanceIntegrityGate(
  companyRoot: string,
  config: ProductionRunnerConfig,
): Promise<void> {
  const verifierPath = path.resolve(companyRoot, 'scripts', 'Test-GovernanceIntegrity.ps1');
  const manifestPath = path.resolve(companyRoot, 'config', 'governance-integrity.json');
  try {
    await Promise.all([access(verifierPath), access(manifestPath)]);
    await execFileAsync(
      process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        verifierPath,
        '-ManifestPath',
        manifestPath,
        '-Role',
        config.target_owner,
        '-Operation',
        'Admission',
        '-TaskId',
        config.task_id,
        '-WorktreePath',
        runnerCheckoutRoot,
        '-Consumer',
        'CompanyRunner',
      ],
      {
        cwd: companyRoot,
        timeout: GOVERNANCE_INTEGRITY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error('Shared governance integrity gate failed closed.');
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function isNormalizedUniqueNonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry === entry.trim(),
    ) &&
    new Set(value).size === value.length
  );
}

function containsCredentialContent(value: unknown): boolean {
  if (typeof value === 'string') return CREDENTIAL_CONTENT.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialContent);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /(?:password|secret|token|private[_-]?key)/i.test(key) || containsCredentialContent(nested),
  );
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error('Production launch artifact is missing, unreadable, or malformed.');
  }
}

function assertAuthorization(value: unknown): asserts value is GoiRedLaunchAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Production launch authorization is not an object.');
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, AUTHORIZATION_KEYS))
    throw new Error('Production launch authorization has missing or unknown fields.');
  if (!record.github || typeof record.github !== 'object' || Array.isArray(record.github))
    throw new Error('Production launch authorization GitHub facts are malformed.');
  if (!hasExactKeys(record.github as Record<string, unknown>, GITHUB_KEYS))
    throw new Error('Production launch authorization GitHub facts have missing or unknown fields.');
  const github = record.github as Record<string, unknown>;
  if (!github.scope || typeof github.scope !== 'object' || Array.isArray(github.scope))
    throw new Error('Production launch authorization GitHub scope is malformed.');
  const scope = github.scope as Record<string, unknown>;
  if (!hasExactKeys(scope, GITHUB_SCOPE_KEYS) || !Array.isArray(scope.files))
    throw new Error('Production launch authorization GitHub scope has missing or unknown fields.');
  if (
    scope.files.some(
      (file) =>
        !file ||
        typeof file !== 'object' ||
        Array.isArray(file) ||
        !hasExactKeys(file as Record<string, unknown>, GITHUB_FILE_KEYS),
    )
  )
    throw new Error('Production launch authorization GitHub file scope is malformed.');
  const credentialSafeCopy = { ...record, credential_environment_variable: undefined };
  if (containsCredentialContent(credentialSafeCopy))
    throw new Error('Production launch authorization contains credential-like content.');
  const auth = record as unknown as Partial<GoiRedLaunchAuthorization>;
  const authorizedPair =
    (['READY_FOR_QA', 'QA', 'QA_RETEST'].includes(auth.target_state ?? '') &&
      auth.target_owner === 'Pixel') ||
    (['READY_FOR_REVIEW', 'REVIEW'].includes(auth.target_state ?? '') &&
      auth.target_owner === 'Atlas') ||
    (auth.target_state === 'APPROVED' && auth.target_owner === 'Alex');
  if (
    !['1', '2'].includes(auth.schema_version ?? '') ||
    auth.authorization !== 'RED' ||
    auth.authorized_by !== 'Goi' ||
    typeof auth.task_id !== 'string' ||
    !/^TASK-\d{3,}$/.test(auth.task_id) ||
    !authorizedPair ||
    auth.credential_environment_variable !== 'GH_TOKEN' ||
    auth.max_dispatches !== 1 ||
    !auth.github ||
    !SHA256.test(auth.target_sha256 ?? '') ||
    !SHA256.test(auth.configuration_sha256 ?? '') ||
    !GIT_SHA.test(auth.runner_commit ?? '') ||
    !isNormalizedUniqueNonEmptyStrings(auth.argument_template) ||
    !isNormalizedUniqueNonEmptyStrings(auth.expected_effects) ||
    !isNormalizedUniqueNonEmptyStrings(auth.stop_conditions) ||
    typeof auth.rollback !== 'string' ||
    auth.rollback.length === 0 ||
    auth.rollback !== auth.rollback.trim() ||
    !Number.isInteger(auth.timeout_ms) ||
    (auth.timeout_ms ?? 0) < 1 ||
    (auth.timeout_ms ?? 0) > 120_000
  )
    throw new Error('Production launch authorization violates the exact RED contract.');
  const exactScope = auth.github.scope;
  if (
    typeof auth.github.draft !== 'boolean' ||
    !Number.isInteger(exactScope.commits) ||
    exactScope.commits < 1 ||
    !Number.isInteger(exactScope.additions) ||
    exactScope.additions < 0 ||
    !Number.isInteger(exactScope.deletions) ||
    exactScope.deletions < 0 ||
    !Number.isInteger(exactScope.changedFiles) ||
    exactScope.changedFiles !== exactScope.files.length ||
    exactScope.files.some(
      (file) =>
        typeof file.path !== 'string' ||
        !file.path ||
        file.path !== file.path.trim() ||
        typeof file.status !== 'string' ||
        !file.status ||
        !Number.isInteger(file.additions) ||
        file.additions < 0 ||
        !Number.isInteger(file.deletions) ||
        file.deletions < 0 ||
        !Number.isInteger(file.changes) ||
        file.changes !== file.additions + file.deletions,
    ) ||
    exactScope.files.reduce((sum, file) => sum + file.additions, 0) !== exactScope.additions ||
    exactScope.files.reduce((sum, file) => sum + file.deletions, 0) !== exactScope.deletions
  )
    throw new Error('Production launch authorization GitHub scope violates the exact contract.');
}

function hashTaskBytes(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactAuthorization(
  config: ProductionRunnerConfig,
  auth: GoiRedLaunchAuthorization,
): void {
  const configurationSha256 = productionConfigurationSha256(config);
  if (auth.configuration_sha256 !== configurationSha256)
    throw new Error('Production launch authorization does not cover the canonical configuration.');
  if (auth.schema_version !== config.schema_version || auth.task_id !== config.task_id)
    throw new Error('Production authorization schema or task identity drifted.');
  if (
    auth.target_state === config.target_state &&
    auth.target_owner === config.target_owner &&
    auth.target_sha256 !== config.target_sha256
  )
    throw new Error('Initial production authorization target fingerprint drifted.');
  const exact: Array<[string, unknown, unknown]> = [
    ['Runner commit', auth.runner_commit, config.runner_commit],
    ['executable', auth.executable, config.executable],
    ['Codex version', auth.codex_version, config.codex_version],
    ['approved working root', auth.approved_working_root, config.approved_working_root],
    ['output schema', auth.output_schema, config.output_schema],
    [
      'credential boundary',
      auth.credential_environment_variable,
      config.credential_environment_variable,
    ],
    ['dispatch maximum', auth.max_dispatches, config.max_dispatches],
    ['timeout', auth.timeout_ms, config.timeout_ms],
  ];
  for (const [name, actual, expected] of exact)
    if (actual !== expected) throw new Error(`Production authorization ${name} drifted.`);
  if (JSON.stringify(auth.argument_template) !== JSON.stringify(config.argument_template))
    throw new Error('Production authorization argument template drifted.');
  if (
    JSON.stringify(auth.expected_effects) !==
    JSON.stringify(
      expectedEffectsForAuthorization(auth.target_state, auth.target_owner, auth.task_id),
    )
  )
    throw new Error('Production authorization expected effects drifted.');
  if (auth.rollback !== EXACT_ROLLBACK)
    throw new Error('Production authorization rollback drifted.');
  if (JSON.stringify(auth.stop_conditions) !== JSON.stringify(EXACT_STOP_CONDITIONS))
    throw new Error('Production authorization stop conditions drifted.');
  if (
    auth.github.repository !== config.target_repository ||
    auth.github.issue !== config.target_issue ||
    auth.github.pr !== config.target_pr ||
    auth.github.base !== 'main' ||
    auth.github.branch !==
      (config.schema_version === '1'
        ? 'task/TASK-020-reconcile-company-runner-roadmap'
        : `task/${config.task_id}-runner-v1-activation-canary`) ||
    auth.github.issueState !== 'OPEN' ||
    auth.github.prState !== 'OPEN'
  )
    throw new Error('Production authorization GitHub facts drifted.');
  if (
    auth.target_state === config.target_state &&
    auth.target_owner === config.target_owner &&
    auth.github.head !== config.target_head
  )
    throw new Error('Initial production authorization GitHub head drifted.');
  const authorizedPaths =
    config.schema_version === '1'
      ? [...HISTORICAL_TASK020_FILES]
      : ['documentation/runner-v1-first-activation-canary.md'];
  if (
    JSON.stringify(auth.github.scope.files.map((file) => file.path).sort()) !==
    JSON.stringify(authorizedPaths.sort())
  )
    throw new Error('Production authorization Pull Request scope drifted.');
}

async function probeRunnerCheckout(checkoutRoot: string): Promise<RunnerCheckoutProvenance> {
  try {
    const [rootResult, headResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: checkoutRoot }),
      execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkoutRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
        cwd: checkoutRoot,
      }),
    ]);
    return {
      root: rootResult.stdout.trim(),
      head: headResult.stdout.trim(),
      dirty: statusResult.stdout.length > 0,
    };
  } catch {
    throw new Error('Runner checkout provenance is unavailable or ambiguous.');
  }
}

function assertRunnerCheckout(
  provenance: RunnerCheckoutProvenance,
  authorization: GoiRedLaunchAuthorization,
): void {
  if (
    path.resolve(provenance.root) !== runnerCheckoutRoot ||
    !GIT_SHA.test(provenance.head) ||
    provenance.dirty
  )
    throw new Error('Runner checkout provenance is unavailable, ambiguous, or dirty.');
  if (provenance.head !== authorization.runner_commit)
    throw new Error('Runner checkout is stale or differs from the authorized merged commit.');
}

async function probeProductionCodexVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, ['--version'], {
      env: environment,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    throw new Error('Codex version probe failed.');
  }
}

async function probeManagedCodexAuthentication(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, ['login', 'status'], {
      env: environment,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    throw new Error('Managed-context Codex authentication is unavailable.');
  }
}

function sanitizeResult(result: RunOnceResult): SanitizedProductionLaunchResult {
  const { github, ...decision } = result.decision;
  const dispatch = result.dispatch
    ? (({ output: _output, ...safeDispatch }) => safeDispatch)(result.dispatch)
    : undefined;
  return {
    run_id: result.run_id,
    outcome: result.outcome,
    decision: { ...decision, ...(github ? { github } : {}) },
    ...(dispatch ? { dispatch } : {}),
    ...(result.approval ? { approval: result.approval } : {}),
  };
}

/**
 * Explicit production entry point. It is deliberately a one-shot function:
 * it does not install a service, persist configuration, or select a task.
 */
export async function launchProductionCompanyRunner(
  options: ProductionLaunchOptions,
): Promise<SanitizedProductionLaunchResult> {
  const config = validateProductionRunnerConfig(await readJson(options.configPath));
  await enforceSharedGovernanceIntegrityGate(options.companyRoot, config);
  const authorization = await readJson(options.authorizationPath);
  assertAuthorization(authorization);
  assertExactAuthorization(config, authorization);
  if (config.active) throw new Error('Production configuration must remain inactive.');

  const provenance = await (options.checkoutProbe ?? probeRunnerCheckout)(runnerCheckoutRoot);
  assertRunnerCheckout(provenance, authorization);

  const probeEnvironment = buildGovernedChildEnvironment(
    options.parentEnvironment ?? process.env,
    config.credential_environment_variable,
  );
  delete probeEnvironment[config.credential_environment_variable];
  const installedVersion = await (options.versionProbe ?? probeProductionCodexVersion)(
    config.executable,
    probeEnvironment,
  );
  if (installedVersion !== authorization.codex_version || installedVersion !== config.codex_version)
    throw new Error('Installed Codex version differs from the exact authorization.');
  if (config.schema_version === '2') {
    const authenticationStatus = await (
      options.codexAuthenticationProbe ?? probeManagedCodexAuthentication
    )(config.executable, probeEnvironment);
    if (!/^Logged in(?:\s|$)/i.test(authenticationStatus.trim()))
      throw new Error('Managed-context Codex authentication is unavailable.');
  }
  if (path.resolve(options.companyRoot) !== path.resolve(config.approved_working_root))
    throw new Error('Production Company Runner root drifted from the canonical package.');

  const task = await readRunnerTask(options.companyRoot, config.task_id);
  if (
    task.state !== authorization.target_state ||
    task.owner !== authorization.target_owner ||
    path.resolve(task.path) !== path.resolve(config.target_path) ||
    hashTaskBytes(task.bytes) !== authorization.target_sha256
  )
    throw new Error('Production target identity or fingerprint drifted.');

  const githubResolver = new GhCliGitHubFactResolver({
    credentialEnvironmentVariable: config.credential_environment_variable,
    parentEnvironment: options.parentEnvironment,
    includePullRequestScope: true,
    ...(options.githubRun ? { run: options.githubRun } : {}),
  });
  const guardedResolver = {
    resolve: async (currentTask: typeof task, signal: AbortSignal): Promise<GitHubFacts> => {
      const facts = await githubResolver.resolve(currentTask, signal);
      if (JSON.stringify(facts) !== JSON.stringify(authorization.github))
        throw new Error('Live GitHub facts do not match the exact RED authorization.');
      return facts;
    },
  };
  const exactVersionProbe = async (
    _executable: string,
    _environment: NodeJS.ProcessEnv,
  ): Promise<string> => installedVersion;
  const dispatcher = new CodexAgentDispatcher({
    executable: config.executable,
    allowedExecutable: config.executable,
    workingRoot: config.approved_working_root,
    approvedWorkingRoot: config.approved_working_root,
    outputSchemaPath: config.output_schema,
    timeoutMs: config.timeout_ms,
    credentialEnvironmentVariable: config.credential_environment_variable,
    parentEnvironment: options.parentEnvironment,
    versionProbe: exactVersionProbe,
    ...(options.globalCapabilityProbe
      ? { globalCapabilityProbe: options.globalCapabilityProbe }
      : {}),
    ...(options.capabilityProbe ? { capabilityProbe: options.capabilityProbe } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
  });
  try {
    const result = await runCompanyOnce({
      companyRoot: options.companyRoot,
      taskId: config.task_id,
      stateDirectory: config.state_directory,
      dispatcher,
      githubResolver: guardedResolver,
      stopFile: config.stop_file,
      timeoutMs: config.timeout_ms,
      leaseTtlMs: config.lease_ttl_ms,
      heartbeatMs: config.heartbeat_ms,
      circuitFailureThreshold: config.circuit_failure_threshold,
      approvalSchemaPath: path.resolve(
        options.companyRoot,
        'docs/schemas/company-runner-approval-v1.schema.json',
      ),
    });
    return sanitizeResult(result);
  } catch {
    throw new Error('Production Company Runner launch failed closed.');
  }
}
