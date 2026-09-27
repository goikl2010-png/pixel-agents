import { execFile } from 'child_process';
import { createHash } from 'crypto';
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
  type RunOnceResult,
} from './companyRunner.js';
import {
  ManifestBoundGitPublisher,
  MarkdownRunnerTransitionWriter,
  SpecialistCheckpointStore,
  validateWorkspaceDescriptorV1,
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
  governanceGate?: (role: EmployeeIdentity, taskId: string, workspace: string) => Promise<void>;
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
    !['company_root', 'state_directory', 'stop_file', 'executable', 'output_schema'].every(
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
  const task = await readRunnerTask(manifest.company_root, manifest.task_id);
  const rawWorkspace = manifest.workspaces.find((candidate) => candidate.role === task.owner);
  const workspace = validateWorkspaceDescriptorV1(rawWorkspace, {
    taskId: task.id,
    role: task.owner,
  });
  try {
    if (options.governanceGate) {
      await options.governanceGate(task.owner, task.id, workspace.root);
    } else {
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
          workspace.root,
          '-Consumer',
          'CompanyRunner',
        ],
        { cwd: manifest.company_root, timeout: 180_000, windowsHide: true },
      );
    }
  } catch {
    throw new Error('Company Runner V1 shared governance integrity gate failed closed.');
  }
  const outputSchema = path.resolve(manifest.output_schema);
  const dispatcher =
    options.dispatcher ??
    new CodexAgentDispatcher({
      executable: manifest.executable,
      allowedExecutable: manifest.executable,
      workingRoot: workspace.root,
      approvedWorkingRoot: workspace.root,
      outputSchemaPath: outputSchema,
      timeoutMs: manifest.timeout_ms,
      credentialEnvironmentVariable: 'GH_TOKEN',
      githubNetworkPolicy: 'governance',
      parentEnvironment: options.parentEnvironment,
    });
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
      contextSources: async (currentTask, role) => {
        const configured = manifest.context_sources
          .filter((source) => source.roles.includes(role))
          .map(({ id, path: sourcePath }) => ({ id, path: sourcePath }));
        const checkpointDirectory = path.join(
          manifest.state_directory,
          'checkpoints',
          currentTask.id,
        );
        let checkpointNames: string[] = [];
        try {
          checkpointNames = (await fs.readdir(checkpointDirectory))
            .filter((name) => name.endsWith('.json'))
            .sort();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return [
          { id: 'authoritative-task', path: currentTask.path },
          ...configured,
          ...checkpointNames.map((name) => ({
            id: `checkpoint-${path.basename(name, '.json')}`,
            path: path.join(checkpointDirectory, name),
          })),
        ];
      },
      publisher: new ManifestBoundGitPublisher(),
      checkpointStore: new SpecialistCheckpointStore(
        path.join(manifest.state_directory, 'checkpoints'),
      ),
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
