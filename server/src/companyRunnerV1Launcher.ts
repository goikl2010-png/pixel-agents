import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { type EmployeeIdentity } from './actionableTaskDiscovery.js';
import {
  type AgentDispatcher,
  CodexAgentDispatcher,
  GhCliGitHubFactResolver,
  type GitHubFactResolver,
  readRunnerTask,
  runCompanyOnce,
  type RunnerTask,
  type RunOnceResult,
} from './companyRunner.js';
import {
  buildContextManifestV1,
  type ContextManifestV1,
  ManifestBoundGitPublisher,
  MarkdownRunnerTransitionWriter,
  resolveWorkspaceDescriptorV1,
  SpecialistCheckpointStore,
  type WorkspaceDescriptorV1,
} from './companyRunnerContract.js';

interface RunnerV1ContextSource {
  id: string;
  path: string;
  roles: EmployeeIdentity[];
}

export interface CompanyRunnerV1Manifest {
  schema_version: '1';
  activation_hold: boolean;
  task_id: string;
  company_root: string;
  runner_worktree: string;
  state_directory: string;
  stop_file: string;
  executable: string;
  output_schema: string;
  timeout_ms: number;
  lease_ttl_ms: number;
  heartbeat_ms: number;
  circuit_failure_threshold: number;
  workspaces: WorkspaceDescriptorV1[];
  context_sources: RunnerV1ContextSource[];
}

export interface CompanyRunnerV1OwnerAuthorization {
  schema_version: '1';
  authorization: 'RED';
  authorized_by: 'Goi';
  task_id: string;
  manifest_sha256: string;
}

export interface CompanyRunnerV1LaunchOptions {
  manifestPath: string;
  authorization?: CompanyRunnerV1OwnerAuthorization;
  authorizationPath?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
  dispatcher?: AgentDispatcher;
  githubResolver?: GitHubFactResolver;
  governanceGate?: CompanyRunnerV1GovernanceGate;
}

export interface CompanyRunnerV1ReadinessOptions {
  manifestPath: string;
  governanceGate?: CompanyRunnerV1GovernanceGate;
}

export interface CompanyRunnerV1ReadinessResult {
  schema_version: '1';
  task_id: string;
  role: EmployeeIdentity;
  outcome: 'HELD_READY';
  manifest_sha256: string;
  context_manifest_sha256: string;
  runner_worktree: string;
  role_worktree: string;
}

type CompanyRunnerV1GovernanceConsumer =
  'CompanyRunner' | 'CompanyRunnerReadiness' | 'RoleOperator';

type CompanyRunnerV1GovernanceGate = (
  role: EmployeeIdentity,
  taskId: string,
  workspace: string,
  consumer: CompanyRunnerV1GovernanceConsumer,
) => Promise<void>;

interface CompanyRunnerV1ResolvedInputs {
  manifest: CompanyRunnerV1Manifest;
  manifestHash: string;
  task: RunnerTask;
  workspace: WorkspaceDescriptorV1;
  runnerWorktree: string;
  checkpointStore: SpecialistCheckpointStore;
}

const ROLES: EmployeeIdentity[] = ['Alex', 'Nova', 'Pixel', 'Atlas'];
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function assertManifest(value: unknown): asserts value is CompanyRunnerV1Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Company Runner V1 manifest must be an object.');
  const manifest = value as Record<string, unknown>;
  if (
    !exactKeys(manifest, [
      'schema_version',
      'activation_hold',
      'task_id',
      'company_root',
      'runner_worktree',
      'state_directory',
      'stop_file',
      'executable',
      'output_schema',
      'timeout_ms',
      'lease_ttl_ms',
      'heartbeat_ms',
      'circuit_failure_threshold',
      'workspaces',
      'context_sources',
    ]) ||
    manifest.schema_version !== '1' ||
    typeof manifest.activation_hold !== 'boolean' ||
    typeof manifest.task_id !== 'string' ||
    !/^TASK-\d+$/.test(manifest.task_id) ||
    ![
      'company_root',
      'runner_worktree',
      'state_directory',
      'stop_file',
      'executable',
      'output_schema',
    ].every(
      (key) => typeof manifest[key] === 'string' && path.isAbsolute(manifest[key] as string),
    ) ||
    !['timeout_ms', 'lease_ttl_ms', 'heartbeat_ms', 'circuit_failure_threshold'].every(
      (key) => Number.isInteger(manifest[key]) && (manifest[key] as number) > 0,
    ) ||
    !Array.isArray(manifest.workspaces) ||
    manifest.workspaces.length !== ROLES.length ||
    !Array.isArray(manifest.context_sources) ||
    manifest.context_sources.length === 0
  )
    throw new Error('Company Runner V1 manifest is malformed.');
  const roles = (manifest.workspaces as Array<Record<string, unknown>>).map((item) => item.role);
  if (JSON.stringify([...roles].sort()) !== JSON.stringify([...ROLES].sort()))
    throw new Error('Company Runner V1 manifest requires exactly one workspace per role.');
  for (const source of manifest.context_sources as Array<Record<string, unknown>>) {
    if (
      !exactKeys(source, ['id', 'path', 'roles']) ||
      typeof source.id !== 'string' ||
      typeof source.path !== 'string' ||
      !path.isAbsolute(source.path) ||
      !Array.isArray(source.roles) ||
      source.roles.length === 0 ||
      source.roles.some((role) => !ROLES.includes(role as EmployeeIdentity))
    )
      throw new Error('Company Runner V1 context source is malformed.');
  }
}

function assertAuthorization(
  value: CompanyRunnerV1OwnerAuthorization,
  manifest: CompanyRunnerV1Manifest,
  manifestHash: string,
): void {
  if (
    !value ||
    !exactKeys(value as unknown as Record<string, unknown>, [
      'schema_version',
      'authorization',
      'authorized_by',
      'task_id',
      'manifest_sha256',
    ]) ||
    value.schema_version !== '1' ||
    value.authorization !== 'RED' ||
    value.authorized_by !== 'Goi' ||
    value.task_id !== manifest.task_id ||
    value.manifest_sha256 !== manifestHash ||
    !SHA256_ID.test(value.manifest_sha256)
  )
    throw new Error('Company Runner V1 owner authorization is absent, malformed, or drifted.');
}

async function runGovernanceGate(
  manifest: CompanyRunnerV1Manifest,
  task: RunnerTask,
  worktree: string,
  consumer: CompanyRunnerV1GovernanceConsumer,
  governanceGate?: CompanyRunnerV1GovernanceGate,
): Promise<void> {
  if (governanceGate) {
    await governanceGate(task.owner, task.id, worktree, consumer);
    return;
  }
  await execFileAsync(
    process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(manifest.company_root, 'scripts', 'Test-GovernanceIntegrity.ps1'),
      '-ManifestPath',
      path.join(manifest.company_root, 'config', 'governance-integrity.json'),
      '-Role',
      task.owner,
      '-Operation',
      'Admission',
      '-TaskId',
      task.id,
      '-WorktreePath',
      worktree,
      '-Consumer',
      consumer,
    ],
    { cwd: manifest.company_root, timeout: 180_000, windowsHide: true },
  );
}

async function resolveCompanyRunnerV1Inputs(
  manifest: CompanyRunnerV1Manifest,
  manifestHash: string,
  runnerConsumer: 'CompanyRunner' | 'CompanyRunnerReadiness',
  governanceGate?: CompanyRunnerV1GovernanceGate,
): Promise<CompanyRunnerV1ResolvedInputs> {
  const task = await readRunnerTask(manifest.company_root, manifest.task_id);
  const rawWorkspace = manifest.workspaces.find((candidate) => candidate.role === task.owner);
  const workspace = await resolveWorkspaceDescriptorV1(rawWorkspace, {
    taskId: task.id,
    role: task.owner,
  });
  const runnerWorktree = await fs.realpath(manifest.runner_worktree);
  const comparable = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(runnerWorktree) === comparable(workspace.root))
    throw new Error('Company Runner and role workspaces must remain isolated.');
  try {
    await runGovernanceGate(manifest, task, runnerWorktree, runnerConsumer, governanceGate);
    await runGovernanceGate(manifest, task, workspace.root, 'RoleOperator', governanceGate);
  } catch {
    throw new Error('Company Runner V1 shared governance integrity gate failed closed.');
  }
  return {
    manifest,
    manifestHash,
    task,
    workspace,
    runnerWorktree,
    checkpointStore: new SpecialistCheckpointStore(
      path.join(manifest.state_directory, 'checkpoints'),
    ),
  };
}

async function contextSourcesForTask(
  manifest: CompanyRunnerV1Manifest,
  task: RunnerTask,
  role: EmployeeIdentity,
  checkpointStore: SpecialistCheckpointStore,
): Promise<Array<{ id: string; path: string }>> {
  const configured = manifest.context_sources
    .filter((source) => source.roles.includes(role))
    .map(({ id, path: sourcePath }) => ({ id, path: sourcePath }));
  const checkpointDirectory = path.join(manifest.state_directory, 'checkpoints', task.id);
  let checkpointNames: string[] = [];
  try {
    checkpointNames = (await fs.readdir(checkpointDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const priorStateCheckpoints: Array<{ id: string; path: string }> = [];
  for (const name of checkpointNames) {
    const dispatchId = `sha256:${path.basename(name, '.json')}`;
    const checkpoint = await checkpointStore.load(task.id, dispatchId);
    if (!checkpoint)
      throw new Error('Enumerated specialist checkpoint disappeared during context loading.');
    if (checkpoint.from_state !== task.state)
      priorStateCheckpoints.push({
        id: `checkpoint-${path.basename(name, '.json')}`,
        path: path.join(checkpointDirectory, name),
      });
  }
  return [{ id: 'authoritative-task', path: task.path }, ...configured, ...priorStateCheckpoints];
}

async function assertFile(pathname: string, label: string): Promise<void> {
  const stat = await fs.stat(await fs.realpath(pathname));
  if (!stat.isFile()) throw new Error(`${label} is not a file.`);
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareCompanyRunnerV1Readiness(
  options: CompanyRunnerV1ReadinessOptions,
): Promise<CompanyRunnerV1ReadinessResult> {
  const manifestBytes = await fs.readFile(options.manifestPath, 'utf8');
  const parsed = JSON.parse(manifestBytes) as unknown;
  assertManifest(parsed);
  if (!parsed.activation_hold)
    throw new Error('Company Runner V1 held readiness requires activation HOLD.');
  const resolved = await resolveCompanyRunnerV1Inputs(
    parsed,
    sha256(manifestBytes),
    'CompanyRunnerReadiness',
    options.governanceGate,
  );
  await Promise.all([
    assertFile(resolved.manifest.executable, 'Company Runner V1 executable'),
    assertFile(resolved.manifest.output_schema, 'Company Runner V1 output schema'),
  ]);
  if (await pathExists(resolved.manifest.stop_file))
    throw new Error('Company Runner V1 stop control is asserted.');
  const leasePath = path.join(
    resolved.manifest.state_directory,
    'leases',
    `${resolved.task.id}.lock`,
  );
  if (await pathExists(leasePath)) throw new Error('Company Runner V1 task lease is active.');
  const contextManifest: ContextManifestV1 = await buildContextManifestV1({
    taskId: resolved.task.id,
    role: resolved.task.owner,
    roots: [
      resolved.manifest.company_root,
      resolved.workspace.root,
      resolved.manifest.state_directory,
    ],
    sources: await contextSourcesForTask(
      resolved.manifest,
      resolved.task,
      resolved.task.owner,
      resolved.checkpointStore,
    ),
  });
  return {
    schema_version: '1',
    task_id: resolved.task.id,
    role: resolved.task.owner,
    outcome: 'HELD_READY',
    manifest_sha256: resolved.manifestHash,
    context_manifest_sha256: contextManifest.manifest_sha256,
    runner_worktree: resolved.runnerWorktree,
    role_worktree: resolved.workspace.root,
  };
}

export async function launchCompanyRunnerV1(
  options: CompanyRunnerV1LaunchOptions,
): Promise<RunOnceResult> {
  const manifestBytes = await fs.readFile(options.manifestPath, 'utf8');
  const parsed = JSON.parse(manifestBytes) as unknown;
  assertManifest(parsed);
  const manifest = parsed;
  if (manifest.activation_hold) throw new Error('Company Runner V1 activation HOLD is asserted.');
  if ((options.authorization ? 1 : 0) + (options.authorizationPath ? 1 : 0) !== 1)
    throw new Error('Company Runner V1 requires exactly one owner authorization source.');
  const authorization = options.authorization
    ? options.authorization
    : (JSON.parse(
        await fs.readFile(options.authorizationPath!, 'utf8'),
      ) as CompanyRunnerV1OwnerAuthorization);
  assertAuthorization(authorization, manifest, sha256(manifestBytes));
  const resolved = await resolveCompanyRunnerV1Inputs(
    manifest,
    sha256(manifestBytes),
    'CompanyRunner',
    options.governanceGate,
  );
  const { workspace, checkpointStore } = resolved;
  const configuredOutputSchema = path.resolve(manifest.output_schema);
  const dispatcher =
    options.dispatcher ??
    ({
      dispatch: async (packet, signal) => {
        const schemaDirectory = await fs.mkdtemp(
          path.join(workspace.root, '.company-runner-schema-'),
        );
        const outputSchema = path.join(schemaDirectory, 'agent-result.schema.json');
        try {
          await fs.copyFile(configuredOutputSchema, outputSchema, constants.COPYFILE_EXCL);
          await fs.chmod(outputSchema, 0o444);
          return await new CodexAgentDispatcher({
            executable: manifest.executable,
            allowedExecutable: manifest.executable,
            workingRoot: workspace.root,
            approvedWorkingRoot: workspace.root,
            outputSchemaPath: outputSchema,
            timeoutMs: manifest.timeout_ms,
            credentialEnvironmentVariable: 'GH_TOKEN',
            githubNetworkPolicy: 'governance',
            parentEnvironment: options.parentEnvironment,
          }).dispatch(packet, signal);
        } finally {
          await fs.chmod(outputSchema, 0o600).catch(() => undefined);
          await fs.unlink(outputSchema).catch(() => undefined);
          await fs.rmdir(schemaDirectory).catch(() => undefined);
        }
      },
    } satisfies AgentDispatcher);
  const githubResolver =
    options.githubResolver ??
    new GhCliGitHubFactResolver({
      credentialEnvironmentVariable: 'GH_TOKEN',
      parentEnvironment: options.parentEnvironment,
      includePullRequestScope: true,
    });
  return runCompanyOnce({
    companyRoot: manifest.company_root,
    taskId: manifest.task_id,
    stateDirectory: manifest.state_directory,
    stopFile: manifest.stop_file,
    timeoutMs: manifest.timeout_ms,
    leaseTtlMs: manifest.lease_ttl_ms,
    heartbeatMs: manifest.heartbeat_ms,
    circuitFailureThreshold: manifest.circuit_failure_threshold,
    dispatcher,
    githubResolver,
    productionContract: {
      workspace,
      contextRoots: [manifest.company_root, workspace.root, manifest.state_directory],
      contextSources: (currentTask, role) =>
        contextSourcesForTask(manifest, currentTask, role, checkpointStore),
      publisher: new ManifestBoundGitPublisher(),
      checkpointStore,
      transitionWriter: new MarkdownRunnerTransitionWriter(manifest.company_root),
      completionVerifier: async (completion, currentTask, signal) => {
        const facts = await githubResolver.resolve(currentTask, signal);
        if (
          facts.repository !== completion.repository ||
          facts.issue !== completion.issue ||
          facts.issueState !== completion.issue_state ||
          facts.pr !== completion.pull_request ||
          facts.prState !== completion.pull_request_state ||
          facts.branch !== completion.branch ||
          facts.head !== completion.head_sha ||
          facts.merge !== completion.merge_sha
        )
          throw new Error('Fresh GitHub merge/closure facts differ from Alex completion receipt.');
      },
      ownerAuthorizedAlexCompletion: true,
    },
  });
}
