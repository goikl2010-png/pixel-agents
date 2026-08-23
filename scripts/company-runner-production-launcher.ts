import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';

import {
  type AgentDispatcher,
  CodexAgentDispatcher,
  GhCliGitHubFactResolver,
  type GitHubFacts,
  readRunnerTask,
  runCompanyOnce,
  type RunOnceResult,
} from '../server/src/companyRunner.js';
import {
  task019ConfigurationSha256,
  type Task019PreflightConfig,
  validateTask019PreflightConfig,
} from './company-runner-task-019-preflight.js';

export interface GoiRedLaunchAuthorization {
  schema_version: '1';
  authorization: 'RED';
  authorized_by: 'Goi';
  task_id: 'TASK-020';
  target_state: 'READY_FOR_QA';
  target_owner: 'Pixel';
  target_sha256: string;
  github: GitHubFacts;
  configuration_sha256: string;
  runner_commit: string;
  executable: string;
  codex_version: 'codex-cli 0.149.0';
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
  dispatcher?: AgentDispatcher;
  githubRun?: (
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<unknown>;
  versionProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  globalCapabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  capabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  spawnProcess?: ConstructorParameters<typeof CodexAgentDispatcher>[0]['spawnProcess'];
}

export interface SanitizedProductionLaunchResult {
  run_id: string;
  outcome: RunOnceResult['outcome'];
  decision: Omit<RunOnceResult['decision'], 'github'> & { github?: GitHubFacts };
  dispatch?: Omit<NonNullable<RunOnceResult['dispatch']>, 'output'>;
}

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
  const auth = value as Partial<GoiRedLaunchAuthorization>;
  if (
    auth.schema_version !== '1' ||
    auth.authorization !== 'RED' ||
    auth.authorized_by !== 'Goi' ||
    auth.task_id !== 'TASK-020' ||
    auth.target_state !== 'READY_FOR_QA' ||
    auth.target_owner !== 'Pixel' ||
    auth.credential_environment_variable !== 'GH_TOKEN' ||
    auth.max_dispatches !== 1 ||
    !auth.github ||
    !SHA256.test(auth.target_sha256 ?? '') ||
    !SHA256.test(auth.configuration_sha256 ?? '') ||
    !GIT_SHA.test(auth.runner_commit ?? '') ||
    !Array.isArray(auth.argument_template) ||
    !Array.isArray(auth.expected_effects) ||
    !Array.isArray(auth.stop_conditions) ||
    typeof auth.rollback !== 'string' ||
    !Number.isInteger(auth.timeout_ms) ||
    (auth.timeout_ms ?? 0) < 1 ||
    (auth.timeout_ms ?? 0) > 120_000
  )
    throw new Error('Production launch authorization violates the exact RED contract.');
}

function hashTaskBytes(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactAuthorization(
  config: Task019PreflightConfig,
  auth: GoiRedLaunchAuthorization,
): void {
  const configurationSha256 = task019ConfigurationSha256(config);
  if (auth.configuration_sha256 !== configurationSha256)
    throw new Error('Production launch authorization does not cover the canonical configuration.');
  const exact: Array<[string, unknown, unknown]> = [
    ['runner commit', auth.runner_commit, config.runner_commit],
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
    auth.github.repository !== config.target_repository ||
    auth.github.issue !== config.target_issue ||
    auth.github.pr !== config.target_pr ||
    auth.github.base !== 'main' ||
    auth.github.branch !== 'task/TASK-020-reconcile-company-runner-roadmap' ||
    auth.github.head !== config.target_head ||
    auth.github.issueState !== 'OPEN' ||
    auth.github.prState !== 'OPEN' ||
    auth.github.draft
  )
    throw new Error('Production authorization GitHub facts drifted.');
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
  };
}

/**
 * Explicit production entry point. It is deliberately a one-shot function:
 * it does not install a service, persist configuration, or select a task.
 */
export async function launchProductionCompanyRunner(
  options: ProductionLaunchOptions,
): Promise<SanitizedProductionLaunchResult> {
  const config = validateTask019PreflightConfig(await readJson(options.configPath));
  const authorization = await readJson(options.authorizationPath);
  assertAuthorization(authorization);
  assertExactAuthorization(config, authorization);
  if (config.active) throw new Error('TASK-019 configuration must remain inactive.');
  if (path.resolve(options.companyRoot) !== path.resolve(config.approved_working_root))
    throw new Error('Production Company Runner root drifted from the canonical package.');

  const task = await readRunnerTask(options.companyRoot, config.task_id);
  if (
    task.state !== config.target_state ||
    task.owner !== config.target_owner ||
    path.resolve(task.path) !== path.resolve(config.target_path) ||
    hashTaskBytes(task.bytes) !== config.target_sha256
  )
    throw new Error('Production target identity or fingerprint drifted.');

  const githubResolver = new GhCliGitHubFactResolver({
    credentialEnvironmentVariable: config.credential_environment_variable,
    parentEnvironment: options.parentEnvironment,
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
  const dispatcher =
    options.dispatcher ??
    new CodexAgentDispatcher({
      executable: config.executable,
      allowedExecutable: config.executable,
      workingRoot: config.approved_working_root,
      approvedWorkingRoot: config.approved_working_root,
      outputSchemaPath: config.output_schema,
      timeoutMs: config.timeout_ms,
      credentialEnvironmentVariable: config.credential_environment_variable,
      parentEnvironment: options.parentEnvironment,
      ...(options.versionProbe ? { versionProbe: options.versionProbe } : {}),
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
