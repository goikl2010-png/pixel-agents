import { createHash } from 'crypto';
import { cp, mkdir, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import {
  FakeAgentDispatcher,
  type GitHubFacts,
  runCompanyOnce,
  runnerStatus,
} from '../server/src/companyRunner.js';

export interface ShadowPilotConfig {
  schema_version: '1';
  active: false;
  mode: 'run-once';
  task_id: string;
  max_dispatches: 1;
  dispatcher: 'deterministic-fake';
  approval_policy: 'on-request';
  company_root: string;
  state_directory: string;
  stop_file: string;
  timeout_ms: number;
  lease_ttl_ms: number;
  heartbeat_ms: number;
  circuit_failure_threshold: number;
  workflow_mutation_adapter: false;
  credential_environment_variable: 'GH_TOKEN';
}

const TASK_ID = /^TASK-\d{3}$/;

export function validateShadowPilotConfig(value: unknown): ShadowPilotConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Shadow pilot configuration must be an object.');
  const config = value as Record<string, unknown>;
  const exactKeys = [
    'schema_version',
    'active',
    'mode',
    'task_id',
    'max_dispatches',
    'dispatcher',
    'approval_policy',
    'company_root',
    'state_directory',
    'stop_file',
    'timeout_ms',
    'lease_ttl_ms',
    'heartbeat_ms',
    'circuit_failure_threshold',
    'workflow_mutation_adapter',
    'credential_environment_variable',
  ];
  if (Object.keys(config).sort().join('\n') !== [...exactKeys].sort().join('\n'))
    throw new Error('Shadow pilot configuration has missing or unknown fields.');
  if (
    config.schema_version !== '1' ||
    config.active !== false ||
    config.mode !== 'run-once' ||
    typeof config.task_id !== 'string' ||
    !TASK_ID.test(config.task_id) ||
    config.max_dispatches !== 1 ||
    config.dispatcher !== 'deterministic-fake' ||
    config.approval_policy !== 'on-request' ||
    config.workflow_mutation_adapter !== false ||
    config.credential_environment_variable !== 'GH_TOKEN'
  )
    throw new Error('Shadow pilot configuration violates a non-activation safety invariant.');
  for (const field of ['company_root', 'state_directory', 'stop_file'] as const) {
    if (typeof config[field] !== 'string' || config[field].length === 0)
      throw new Error(`Shadow pilot ${field} must be a non-empty path.`);
  }
  const bounds = {
    timeout_ms: [1, 120_000],
    lease_ttl_ms: [1_000, 30_000],
    heartbeat_ms: [1, 10_000],
    circuit_failure_threshold: [1, 3],
  } as const;
  for (const [field, [minimum, maximum]] of Object.entries(bounds)) {
    const number = config[field];
    if (!Number.isInteger(number) || (number as number) < minimum || (number as number) > maximum)
      throw new Error(`Shadow pilot ${field} exceeds the existing hard bound.`);
  }
  if ((config.heartbeat_ms as number) >= (config.lease_ttl_ms as number))
    throw new Error('Shadow pilot heartbeat must be shorter than its lease TTL.');
  return config as unknown as ShadowPilotConfig;
}

async function hashTree(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        entries.push(
          `${relative}\0${createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex')}`,
        );
      }
    }
  }
  await walk(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export interface ShadowPilotResult {
  outcome: string;
  decision: unknown;
  handoff: unknown;
  status: Record<string, unknown>;
  fixture_sha256_before: string;
  fixture_sha256_after: string;
  source_fixture_unchanged: boolean;
  dispatch_count: number;
  external_mutations: 0;
}

export async function runShadowPilot(options: {
  config: ShadowPilotConfig;
  fixtureRoot: string;
  githubFacts: GitHubFacts;
  approvalSchemaPath: string;
}): Promise<ShadowPilotResult> {
  const config = validateShadowPilotConfig(options.config);
  if (!path.isAbsolute(options.fixtureRoot)) throw new Error('Fixture root must be absolute.');
  const before = await hashTree(options.fixtureRoot);
  const disposableRoot = path.join(tmpdir(), `company-runner-shadow-${before}`);
  const companyRoot = path.join(disposableRoot, 'company');
  const stateDirectory = path.join(disposableRoot, 'state');
  try {
    await mkdir(disposableRoot);
    await cp(options.fixtureRoot, companyRoot, { recursive: true, errorOnExist: true });
    const dispatcher = new FakeAgentDispatcher();
    const result = await runCompanyOnce({
      companyRoot,
      taskId: config.task_id,
      stateDirectory,
      dispatcher,
      githubResolver: { resolve: async () => structuredClone(options.githubFacts) },
      timeoutMs: config.timeout_ms,
      leaseTtlMs: config.lease_ttl_ms,
      heartbeatMs: config.heartbeat_ms,
      circuitFailureThreshold: config.circuit_failure_threshold,
      stopFile: path.resolve(disposableRoot, 'STOP'),
      approvalSchemaPath: options.approvalSchemaPath,
    });
    const after = await hashTree(options.fixtureRoot);
    return {
      outcome: result.outcome,
      decision: result.decision,
      handoff: dispatcher.calls[0] ?? null,
      status: await runnerStatus(companyRoot, config.task_id, stateDirectory),
      fixture_sha256_before: before,
      fixture_sha256_after: after,
      source_fixture_unchanged: before === after,
      dispatch_count: dispatcher.calls.length,
      external_mutations: 0,
    };
  } finally {
    await rm(disposableRoot, { recursive: true, force: true });
  }
}
