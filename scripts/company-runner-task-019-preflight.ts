import { createHash } from 'crypto';

export interface Task019PreflightConfig {
  schema_version: '1';
  active: false;
  mode: 'run-once';
  task_id: 'TASK-020';
  target_repository: 'goikl2010-png/AI-Company';
  target_issue: 3;
  target_pr: 4;
  target_state: 'READY_FOR_QA';
  target_owner: 'Pixel';
  target_path: string;
  target_sha256: string;
  target_head: string;
  runner_commit: string;
  max_dispatches: 1;
  dispatcher: 'codex';
  approval_policy: 'on-request';
  executable: string;
  codex_version: 'codex-cli 0.149.0';
  approved_working_root: string;
  output_schema: string;
  state_directory: string;
  stop_file: string;
  timeout_ms: number;
  lease_ttl_ms: number;
  heartbeat_ms: number;
  circuit_failure_threshold: number;
  workflow_mutation_adapter: false;
  credential_environment_variable: 'GH_TOKEN';
  required_global_capability: '--ask-for-approval on-request';
  required_exec_capabilities: string[];
  argument_template: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REQUIRED_EXEC = [
  '--json',
  '--output-schema <FILE>',
  '--cd <DIR>',
  '--sandbox <SANDBOX_MODE>',
];

export function validateTask019PreflightConfig(value: unknown): Task019PreflightConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TASK-019 preflight configuration must be an object.');
  const config = value as Record<string, unknown>;
  const exactKeys = [
    'schema_version',
    'active',
    'mode',
    'task_id',
    'target_repository',
    'target_issue',
    'target_pr',
    'target_state',
    'target_owner',
    'target_path',
    'target_sha256',
    'target_head',
    'runner_commit',
    'max_dispatches',
    'dispatcher',
    'approval_policy',
    'executable',
    'codex_version',
    'approved_working_root',
    'output_schema',
    'state_directory',
    'stop_file',
    'timeout_ms',
    'lease_ttl_ms',
    'heartbeat_ms',
    'circuit_failure_threshold',
    'workflow_mutation_adapter',
    'credential_environment_variable',
    'required_global_capability',
    'required_exec_capabilities',
    'argument_template',
  ];
  if (Object.keys(config).sort().join('\n') !== exactKeys.sort().join('\n'))
    throw new Error('TASK-019 preflight configuration has missing or unknown fields.');
  if (
    config.schema_version !== '1' ||
    config.active !== false ||
    config.mode !== 'run-once' ||
    config.task_id !== 'TASK-020' ||
    config.target_repository !== 'goikl2010-png/AI-Company' ||
    config.target_issue !== 3 ||
    config.target_pr !== 4 ||
    config.target_state !== 'READY_FOR_QA' ||
    config.target_owner !== 'Pixel' ||
    config.max_dispatches !== 1 ||
    config.dispatcher !== 'codex' ||
    config.approval_policy !== 'on-request' ||
    config.codex_version !== 'codex-cli 0.149.0' ||
    config.workflow_mutation_adapter !== false ||
    config.credential_environment_variable !== 'GH_TOKEN' ||
    config.required_global_capability !== '--ask-for-approval on-request'
  )
    throw new Error('TASK-019 preflight configuration violates a fixed pilot invariant.');
  for (const field of [
    'target_path',
    'executable',
    'approved_working_root',
    'output_schema',
    'state_directory',
    'stop_file',
  ] as const) {
    if (typeof config[field] !== 'string' || !/^[A-Za-z]:\\/.test(config[field] as string))
      throw new Error(`TASK-019 ${field} must be an absolute Windows path.`);
  }
  if (typeof config.target_sha256 !== 'string' || !SHA256.test(config.target_sha256))
    throw new Error('TASK-019 target_sha256 must be a lowercase 64-character hash.');
  for (const field of ['target_head', 'runner_commit'] as const)
    if (typeof config[field] !== 'string' || !GIT_SHA.test(config[field] as string))
      throw new Error(`TASK-019 ${field} must be a lowercase 40-character Git commit.`);
  if (JSON.stringify(config.required_exec_capabilities) !== JSON.stringify(REQUIRED_EXEC))
    throw new Error('TASK-019 exec capability contract is incomplete or reordered.');
  const expectedArguments = [
    '--ask-for-approval',
    'on-request',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--cd',
    config.approved_working_root,
    '--output-schema',
    config.output_schema,
    '<JSON_HANDOFF_PACKET>',
  ];
  if (JSON.stringify(config.argument_template) !== JSON.stringify(expectedArguments))
    throw new Error('TASK-019 Codex argument template is not the approved direct invocation.');
  if (
    typeof config.timeout_ms !== 'number' ||
    !Number.isInteger(config.timeout_ms) ||
    config.timeout_ms < 1 ||
    config.timeout_ms > 120_000 ||
    typeof config.lease_ttl_ms !== 'number' ||
    !Number.isInteger(config.lease_ttl_ms) ||
    config.lease_ttl_ms < 1_000 ||
    config.lease_ttl_ms > 30_000 ||
    typeof config.heartbeat_ms !== 'number' ||
    !Number.isInteger(config.heartbeat_ms) ||
    config.heartbeat_ms < 1 ||
    config.heartbeat_ms > 10_000 ||
    (config.heartbeat_ms as number) >= (config.lease_ttl_ms as number) ||
    !Number.isInteger(config.circuit_failure_threshold) ||
    config.circuit_failure_threshold !== 3
  )
    throw new Error('TASK-019 preflight exceeds an existing hard process bound.');
  const serialized = JSON.stringify(config);
  if (
    /approve-for-me|dangerously-bypass|full-auto|danger-full-access|ask-for-approval[^]*never/i.test(
      serialized,
    )
  )
    throw new Error('TASK-019 preflight contains a forbidden approval or sandbox mode.');
  return config as unknown as Task019PreflightConfig;
}

export function task019ConfigurationSha256(value: unknown): string {
  const config = validateTask019PreflightConfig(value);
  return createHash('sha256')
    .update(`${JSON.stringify(config, null, 2)}\n`)
    .digest('hex');
}
