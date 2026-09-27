import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import type { EmployeeIdentity } from './actionableTaskDiscovery.js';
import { type LifecycleState, storageForLifecycleState } from './handoffTransitionPlanner.js';

export const AGENT_RESULT_V1 = 'AgentResultV1' as const;

export interface WorkspaceDescriptorV1 {
  schema_version: '1';
  task_id: string;
  role: EmployeeIdentity;
  repository: string;
  root: string;
  branch: string;
  base_sha: string;
  allowed_paths: string[];
  protected_paths: string[];
  publication: 'required' | 'not-required';
}

export interface ContextEntryV1 {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ContextManifestV1 {
  schema_version: '1';
  task_id: string;
  role: EmployeeIdentity;
  entries: ContextEntryV1[];
  manifest_sha256: string;
}

export interface PublicationRequestV1 {
  repository: string;
  branch: string;
  base_sha: string;
  changed_paths: string[];
  commit_message: string;
  pull_request: PullRequestRequestV1 | null;
}

export interface PullRequestRequestV1 {
  base: 'main';
  title: string;
  body: string;
}

export interface PullRequestClaimV1 {
  number: number;
  url: string;
  base: 'main';
  head: string;
}

export interface PublicationReceiptV1 {
  schema_version: '1';
  repository: string;
  branch: string;
  base_sha: string;
  commit_sha: string;
  remote_sha: string;
  changed_paths: string[];
  pull_request: PullRequestClaimV1 | null;
}

export interface AgentResultV1 {
  contract: typeof AGENT_RESULT_V1;
  schema_version: '1';
  task_id: string;
  role: EmployeeIdentity;
  from_state: LifecycleState;
  outcome: 'completed' | 'blocked' | 'failed';
  next_state: LifecycleState | null;
  summary: string;
  evidence: string[];
  publication: PublicationRequestV1 | null;
  completion: AgentCompletionV1 | null;
  context_manifest_sha256: string;
}

export interface AgentCompletionV1 {
  repository: string;
  issue: number;
  pull_request: number;
  branch: string;
  head_sha: string;
  merge_sha: string;
  issue_state: 'CLOSED';
  pull_request_state: 'MERGED';
}

export interface SpecialistCheckpointV1 {
  schema_version: '1';
  task_id: string;
  dispatch_id: string;
  role: EmployeeIdentity;
  from_state: LifecycleState;
  result: AgentResultV1;
  publication: PublicationReceiptV1 | null;
  context_manifest_sha256: string;
  checkpoint_sha256: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<GitCommandResult>;

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|@\{|\\|\s|~|\^|:|\?|\*|\[))(?!.*\/$)[A-Za-z0-9._\/-]+$/;
const ROLE_SET = new Set<EmployeeIdentity>(['Alex', 'Nova', 'Pixel', 'Atlas']);

function hash(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function normalizedPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (
    value.length === 0 ||
    value !== value.trim() ||
    path.posix.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`Contract path is not a normalized repository-relative path: ${value}.`);
  return normalized;
}

function normalizedUniquePaths(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    throw new Error('Contract paths must be a non-empty array.');
  const paths = value.map((item) => {
    if (typeof item !== 'string') throw new Error('Contract path must be a string.');
    return normalizedPath(item);
  });
  if (new Set(paths).size !== paths.length) throw new Error('Contract paths must be unique.');
  return paths;
}

function pathMatches(candidate: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('/') ? candidate.startsWith(pattern) : candidate === pattern,
  );
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`${label} escapes its authorized root.`);
}

export function validateWorkspaceDescriptorV1(
  value: unknown,
  expected: { taskId: string; role: EmployeeIdentity },
): WorkspaceDescriptorV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace descriptor must be an object.');
  const descriptor = value as Record<string, unknown>;
  const keys = [
    'schema_version',
    'task_id',
    'role',
    'repository',
    'root',
    'branch',
    'base_sha',
    'allowed_paths',
    'protected_paths',
    'publication',
  ];
  if (!hasExactKeys(descriptor, keys))
    throw new Error('Workspace descriptor has missing or unknown fields.');
  if (
    descriptor.schema_version !== '1' ||
    descriptor.task_id !== expected.taskId ||
    descriptor.role !== expected.role ||
    !ROLE_SET.has(descriptor.role as EmployeeIdentity) ||
    typeof descriptor.repository !== 'string' ||
    !REPOSITORY.test(descriptor.repository) ||
    typeof descriptor.root !== 'string' ||
    !path.isAbsolute(descriptor.root) ||
    typeof descriptor.branch !== 'string' ||
    !BRANCH.test(descriptor.branch) ||
    typeof descriptor.base_sha !== 'string' ||
    !SHA.test(descriptor.base_sha) ||
    !['required', 'not-required'].includes(String(descriptor.publication))
  )
    throw new Error('Workspace descriptor identity or publication policy is invalid.');
  const allowed = normalizedUniquePaths(descriptor.allowed_paths);
  const protectedPaths = normalizedUniquePaths(descriptor.protected_paths, true);
  if (allowed.some((candidate) => pathMatches(candidate, protectedPaths)))
    throw new Error('Workspace allowlist overlaps a protected path.');
  return {
    ...(descriptor as unknown as WorkspaceDescriptorV1),
    allowed_paths: allowed,
    protected_paths: protectedPaths,
  };
}

export async function resolveWorkspaceDescriptorV1(
  value: unknown,
  expected: { taskId: string; role: EmployeeIdentity },
): Promise<WorkspaceDescriptorV1> {
  const descriptor = validateWorkspaceDescriptorV1(value, expected);
  const root = await fs.realpath(descriptor.root);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('Authorized workspace root is not a directory.');
  const broad = path.parse(root).root;
  if (root === broad || root.split(path.sep).filter(Boolean).length < 2)
    throw new Error('Broad filesystem roots cannot be authorized workspaces.');
  return { ...descriptor, root };
}

export async function buildContextManifestV1(options: {
  taskId: string;
  role: EmployeeIdentity;
  roots: string[];
  sources: Array<{ id: string; path: string }>;
}): Promise<ContextManifestV1> {
  if (!/^TASK-\d+$/.test(options.taskId)) throw new Error('Context task identity is invalid.');
  if (!ROLE_SET.has(options.role)) throw new Error('Context role is invalid.');
  const roots = await Promise.all(options.roots.map((root) => fs.realpath(root)));
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const entries: ContextEntryV1[] = [];
  for (const source of options.sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.id) || seenIds.has(source.id))
      throw new Error('Context source IDs must be normalized and unique.');
    seenIds.add(source.id);
    if (!path.isAbsolute(source.path)) throw new Error('Context source path must be absolute.');
    const real = await fs.realpath(source.path);
    if (
      !roots.some((root) => {
        try {
          assertWithin(root, real, 'Context source');
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error('Context source escapes all authorized roots.');
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seenPaths.has(key)) throw new Error('Context source paths must be unique.');
    seenPaths.add(key);
    const bytes = await fs.readFile(real);
    entries.push({ id: source.id, path: real, sha256: hash(bytes), bytes: bytes.length });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const canonical = JSON.stringify(
    entries.map(({ id, path: sourcePath, sha256, bytes }) => ({
      id,
      path: sourcePath.replace(/\\/g, '/'),
      sha256,
      bytes,
    })),
  );
  return {
    schema_version: '1',
    task_id: options.taskId,
    role: options.role,
    entries,
    manifest_sha256: hash(canonical),
  };
}

export function validateAgentResultV1(
  value: unknown,
  expected: {
    taskId: string;
    role: EmployeeIdentity;
    state: LifecycleState;
    contextManifestSha256: string;
  },
): AgentResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('AgentResultV1 must be an object.');
  const result = value as Record<string, unknown>;
  const keys = [
    'contract',
    'schema_version',
    'task_id',
    'role',
    'from_state',
    'outcome',
    'next_state',
    'summary',
    'evidence',
    'publication',
    'completion',
    'context_manifest_sha256',
  ];
  if (!hasExactKeys(result, keys)) throw new Error('AgentResultV1 has missing or unknown fields.');
  if (
    result.contract !== AGENT_RESULT_V1 ||
    result.schema_version !== '1' ||
    result.task_id !== expected.taskId ||
    result.role !== expected.role ||
    result.from_state !== expected.state ||
    !['completed', 'blocked', 'failed'].includes(String(result.outcome)) ||
    typeof result.summary !== 'string' ||
    result.summary.trim().length === 0 ||
    result.summary.length > 4_000 ||
    result.context_manifest_sha256 !== expected.contextManifestSha256 ||
    !SHA256_ID.test(String(result.context_manifest_sha256))
  )
    throw new Error('AgentResultV1 identity, outcome, summary, or context binding is invalid.');
  const evidence = normalizedUniquePaths(result.evidence, true);
  if (result.outcome === 'completed' && typeof result.next_state !== 'string')
    throw new Error('A completed AgentResultV1 requires a next state.');
  if (result.outcome !== 'completed' && result.next_state !== null)
    throw new Error('A non-completed AgentResultV1 cannot request a transition.');
  let completion: AgentCompletionV1 | null = null;
  if (result.completion !== null) {
    if (
      !result.completion ||
      typeof result.completion !== 'object' ||
      Array.isArray(result.completion)
    )
      throw new Error('AgentResultV1 completion receipt is malformed.');
    const receipt = result.completion as Record<string, unknown>;
    if (
      !hasExactKeys(receipt, [
        'repository',
        'issue',
        'pull_request',
        'branch',
        'head_sha',
        'merge_sha',
        'issue_state',
        'pull_request_state',
      ]) ||
      typeof receipt.repository !== 'string' ||
      !REPOSITORY.test(receipt.repository) ||
      !Number.isInteger(receipt.issue) ||
      (receipt.issue as number) < 1 ||
      !Number.isInteger(receipt.pull_request) ||
      (receipt.pull_request as number) < 1 ||
      typeof receipt.branch !== 'string' ||
      !BRANCH.test(receipt.branch) ||
      typeof receipt.head_sha !== 'string' ||
      !SHA.test(receipt.head_sha) ||
      typeof receipt.merge_sha !== 'string' ||
      !SHA.test(receipt.merge_sha) ||
      receipt.issue_state !== 'CLOSED' ||
      receipt.pull_request_state !== 'MERGED'
    )
      throw new Error('AgentResultV1 completion receipt is invalid.');
    completion = receipt as unknown as AgentCompletionV1;
  }
  if (
    result.from_state === 'APPROVED' &&
    result.outcome === 'completed' &&
    result.next_state === 'COMPLETED' &&
    !completion
  )
    throw new Error('Alex completion requires an exact merge and closure receipt.');
  if (result.next_state !== 'COMPLETED' && completion)
    throw new Error('A completion receipt is valid only for the COMPLETED transition.');
  let publication: PublicationRequestV1 | null = null;
  if (result.publication !== null) {
    if (
      !result.publication ||
      typeof result.publication !== 'object' ||
      Array.isArray(result.publication)
    )
      throw new Error('AgentResultV1 publication request is malformed.');
    const request = result.publication as Record<string, unknown>;
    if (
      !hasExactKeys(request, [
        'repository',
        'branch',
        'base_sha',
        'changed_paths',
        'commit_message',
        'pull_request',
      ]) ||
      typeof request.repository !== 'string' ||
      !REPOSITORY.test(request.repository) ||
      typeof request.branch !== 'string' ||
      !BRANCH.test(request.branch) ||
      typeof request.base_sha !== 'string' ||
      !SHA.test(request.base_sha) ||
      typeof request.commit_message !== 'string' ||
      request.commit_message.trim() !== request.commit_message ||
      request.commit_message.length < 1 ||
      request.commit_message.length > 200 ||
      /[\r\n]/.test(request.commit_message)
    )
      throw new Error('AgentResultV1 publication request is invalid.');
    let pullRequest: PullRequestRequestV1 | null = null;
    if (request.pull_request !== null) {
      if (
        !request.pull_request ||
        typeof request.pull_request !== 'object' ||
        Array.isArray(request.pull_request)
      )
        throw new Error('AgentResultV1 Pull Request claim is malformed.');
      const claim = request.pull_request as Record<string, unknown>;
      if (
        !hasExactKeys(claim, ['base', 'title', 'body']) ||
        claim.base !== 'main' ||
        typeof claim.title !== 'string' ||
        claim.title.trim() !== claim.title ||
        claim.title.length < 1 ||
        claim.title.length > 200 ||
        /[\r\n]/.test(claim.title) ||
        typeof claim.body !== 'string' ||
        claim.body.trim().length < 1 ||
        claim.body.length > 10_000
      )
        throw new Error('AgentResultV1 Pull Request request is invalid.');
      pullRequest = claim as unknown as PullRequestRequestV1;
    }
    publication = {
      ...(request as unknown as PublicationRequestV1),
      changed_paths: normalizedUniquePaths(request.changed_paths),
      pull_request: pullRequest,
    };
  }
  return {
    ...(result as unknown as AgentResultV1),
    evidence,
    publication,
    completion,
  };
}

async function defaultGitRun(
  executable: string,
  args: string[],
  cwd: string,
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  return { stdout, stderr };
}

function exactLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function defaultPullRequestVerifier(
  repository: string,
  claim: PullRequestClaimV1,
): Promise<void> {
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const { stdout } = await execFileAsync(
    executable,
    ['api', `repos/${repository}/pulls/${claim.number}`],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  const value = JSON.parse(stdout) as {
    state?: unknown;
    html_url?: unknown;
    base?: { ref?: unknown };
    head?: { ref?: unknown };
  };
  if (
    value.state !== 'open' ||
    value.html_url !== claim.url ||
    value.base?.ref !== claim.base ||
    value.head?.ref !== claim.head
  )
    throw new Error('GitHub Pull Request does not match the exact publication claim.');
}

async function defaultPullRequestEnsurer(
  repository: string,
  branch: string,
  request: PullRequestRequestV1,
): Promise<PullRequestClaimV1> {
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const owner = repository.split('/')[0];
  const query = `repos/${repository}/pulls?state=open&base=${request.base}&head=${owner}:${encodeURIComponent(branch)}`;
  const existing = JSON.parse(
    (
      await execFileAsync(executable, ['api', query], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      })
    ).stdout,
  ) as Array<{
    number?: unknown;
    html_url?: unknown;
    base?: { ref?: unknown };
    head?: { ref?: unknown };
  }>;
  if (!Array.isArray(existing) || existing.length > 1)
    throw new Error('GitHub Pull Request lookup is malformed or ambiguous.');
  if (existing.length === 1) {
    const candidate = existing[0];
    if (
      !Number.isInteger(candidate.number) ||
      typeof candidate.html_url !== 'string' ||
      candidate.base?.ref !== request.base ||
      candidate.head?.ref !== branch
    )
      throw new Error('Existing GitHub Pull Request differs from the publication request.');
    return {
      number: candidate.number as number,
      url: candidate.html_url,
      base: request.base,
      head: branch,
    };
  }
  const created = await execFileAsync(
    executable,
    [
      'pr',
      'create',
      '--repo',
      repository,
      '--base',
      request.base,
      '--head',
      branch,
      '--title',
      request.title,
      '--body',
      request.body,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  const url = created.stdout.trim();
  const match = new RegExp(
    `^https://github\\.com/${repository.replace('/', '\\/')}/pull/([1-9][0-9]*)$`,
  ).exec(url);
  if (!match) throw new Error('GitHub did not return one exact created Pull Request URL.');
  return { number: Number(match[1]), url, base: request.base, head: branch };
}

export class ManifestBoundGitPublisher {
  constructor(
    private readonly executable = process.platform === 'win32' ? 'git.exe' : 'git',
    private readonly run: GitCommandRunner = defaultGitRun,
    private readonly ensurePullRequest: (
      repository: string,
      branch: string,
      request: PullRequestRequestV1,
    ) => Promise<PullRequestClaimV1> = defaultPullRequestEnsurer,
    private readonly verifyPullRequest: (
      repository: string,
      claim: PullRequestClaimV1,
    ) => Promise<void> = defaultPullRequestVerifier,
  ) {}

  async publish(
    descriptor: WorkspaceDescriptorV1,
    request: PublicationRequestV1,
  ): Promise<PublicationReceiptV1> {
    if (descriptor.publication !== 'required')
      throw new Error('Git publication was requested from a non-publishing workspace.');
    if (
      request.repository !== descriptor.repository ||
      request.branch !== descriptor.branch ||
      request.base_sha !== descriptor.base_sha
    )
      throw new Error('Git publication request drifted from the workspace manifest.');
    const changedPaths = normalizedUniquePaths(request.changed_paths).sort();
    if (
      changedPaths.some(
        (candidate) =>
          !pathMatches(candidate, descriptor.allowed_paths) ||
          pathMatches(candidate, descriptor.protected_paths) ||
          candidate === '.git' ||
          candidate.startsWith('.git/'),
      )
    )
      throw new Error('Git publication request contains a non-allowlisted or protected path.');
    const git = async (args: string[]): Promise<GitCommandResult> =>
      this.run(
        this.executable,
        ['-c', `safe.directory=${descriptor.root.replace(/\\/g, '/')}`, ...args],
        descriptor.root,
      );
    const [top, branch, head, origin] = await Promise.all([
      git(['rev-parse', '--show-toplevel']),
      git(['branch', '--show-current']),
      git(['rev-parse', 'HEAD']),
      git(['remote', 'get-url', 'origin']),
    ]);
    const [gitRoot, manifestRoot] = await Promise.all([
      fs.realpath(path.resolve(top.stdout.trim())),
      fs.realpath(path.resolve(descriptor.root)),
    ]);
    const comparable = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(gitRoot) !== comparable(manifestRoot))
      throw new Error('Git publication root differs from the workspace manifest.');
    if (branch.stdout.trim() !== descriptor.branch || head.stdout.trim() !== descriptor.base_sha)
      throw new Error('Git publication branch or base SHA drifted.');
    const normalizedOrigin = origin.stdout.trim().replace(/\.git$/, '');
    if (!normalizedOrigin.endsWith(`/${descriptor.repository}`))
      throw new Error('Git publication origin differs from the workspace manifest.');
    const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => normalizedPath(line.slice(3).trim()));
    if (status.length === 0 || status.some((candidate) => !changedPaths.includes(candidate)))
      throw new Error('Workspace contains clean, unrelated, or ambiguous changes.');
    await git(['add', '--', ...changedPaths]);
    const staged = exactLines(
      (await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])).stdout,
    )
      .map(normalizedPath)
      .sort();
    if (JSON.stringify(staged) !== JSON.stringify(changedPaths))
      throw new Error('Staged Git paths differ from the exact publication request.');
    await git(['commit', '--no-verify', '-m', request.commit_message, '--', ...changedPaths]);
    const commitSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (!SHA.test(commitSha) || commitSha === descriptor.base_sha)
      throw new Error('Git publication did not create one valid commit.');
    const parent = (await git(['rev-parse', `${commitSha}^`])).stdout.trim();
    if (parent !== descriptor.base_sha)
      throw new Error('Git publication commit is not a single child of the authorized base.');
    await git(['push', '--porcelain', 'origin', `HEAD:refs/heads/${descriptor.branch}`]);
    const remote = exactLines(
      (await git(['ls-remote', '--heads', 'origin', `refs/heads/${descriptor.branch}`])).stdout,
    );
    const remoteSha = remote.length === 1 ? remote[0].split(/\s+/)[0] : '';
    if (remoteSha !== commitSha)
      throw new Error('Remote Git head does not verify the publication.');
    const pullRequest = request.pull_request
      ? await this.ensurePullRequest(descriptor.repository, descriptor.branch, request.pull_request)
      : null;
    if (pullRequest) await this.verifyPullRequest(descriptor.repository, pullRequest);
    return {
      schema_version: '1',
      repository: descriptor.repository,
      branch: descriptor.branch,
      base_sha: descriptor.base_sha,
      commit_sha: commitSha,
      remote_sha: remoteSha,
      changed_paths: changedPaths,
      pull_request: pullRequest,
    };
  }

  async verifyReceipt(
    descriptor: WorkspaceDescriptorV1,
    receipt: PublicationReceiptV1,
  ): Promise<void> {
    if (
      receipt.schema_version !== '1' ||
      receipt.repository !== descriptor.repository ||
      receipt.branch !== descriptor.branch ||
      receipt.base_sha !== descriptor.base_sha ||
      receipt.commit_sha !== receipt.remote_sha ||
      !SHA.test(receipt.commit_sha) ||
      receipt.commit_sha === receipt.base_sha
    )
      throw new Error('Publication receipt identity or commit binding is invalid.');
    const changedPaths = normalizedUniquePaths(receipt.changed_paths).sort();
    if (
      changedPaths.some(
        (candidate) =>
          !pathMatches(candidate, descriptor.allowed_paths) ||
          pathMatches(candidate, descriptor.protected_paths),
      )
    )
      throw new Error('Publication receipt contains unauthorized paths.');
    const git = async (args: string[]): Promise<GitCommandResult> =>
      this.run(
        this.executable,
        ['-c', `safe.directory=${descriptor.root.replace(/\\/g, '/')}`, ...args],
        descriptor.root,
      );
    const remote = exactLines(
      (await git(['ls-remote', '--heads', 'origin', `refs/heads/${descriptor.branch}`])).stdout,
    );
    if (remote.length !== 1 || remote[0].split(/\s+/)[0] !== receipt.commit_sha)
      throw new Error('Publication receipt no longer matches the exact remote branch head.');
    const parent = (await git(['rev-parse', `${receipt.commit_sha}^`])).stdout.trim();
    if (parent !== receipt.base_sha)
      throw new Error('Publication receipt commit is not a single child of its authorized base.');
    const committed = exactLines(
      (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', receipt.commit_sha])).stdout,
    )
      .map(normalizedPath)
      .sort();
    if (JSON.stringify(committed) !== JSON.stringify(changedPaths))
      throw new Error('Publication receipt changed paths differ from the verified commit.');
    if (receipt.pull_request)
      await this.verifyPullRequest(descriptor.repository, receipt.pull_request);
  }
}

function checkpointBody(
  checkpoint: Omit<SpecialistCheckpointV1, 'checkpoint_sha256'>,
): Omit<SpecialistCheckpointV1, 'checkpoint_sha256'> {
  return checkpoint;
}

export class SpecialistCheckpointStore {
  constructor(private readonly root: string) {}

  private file(taskId: string, dispatchId: string): string {
    if (!/^TASK-\d+$/.test(taskId) || !SHA256_ID.test(dispatchId))
      throw new Error('Checkpoint identity is invalid.');
    return path.join(this.root, taskId, `${dispatchId.slice('sha256:'.length)}.json`);
  }

  async save(
    value: Omit<SpecialistCheckpointV1, 'schema_version' | 'checkpoint_sha256'>,
  ): Promise<SpecialistCheckpointV1> {
    const body = checkpointBody({ schema_version: '1', ...value });
    const checkpoint = { ...body, checkpoint_sha256: hash(JSON.stringify(body)) };
    const file = this.file(value.task_id, value.dispatch_id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      const handle = await fs.open(
        file,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.load(value.task_id, value.dispatch_id);
      if (JSON.stringify(existing) !== JSON.stringify(checkpoint))
        throw new Error('Specialist checkpoint already exists with different content.');
      return existing!;
    }
    return checkpoint;
  }

  async load(taskId: string, dispatchId: string): Promise<SpecialistCheckpointV1 | null> {
    let bytes: string;
    try {
      bytes = await fs.readFile(this.file(taskId, dispatchId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const checkpoint = JSON.parse(bytes) as SpecialistCheckpointV1;
    const { checkpoint_sha256: stored, ...body } = checkpoint;
    if (!SHA256_ID.test(stored) || hash(JSON.stringify(body)) !== stored)
      throw new Error('Specialist checkpoint integrity failure.');
    if (checkpoint.task_id !== taskId || checkpoint.dispatch_id !== dispatchId)
      throw new Error('Specialist checkpoint identity drifted.');
    return checkpoint;
  }
}

const OWNER_BY_STATE: Readonly<Record<LifecycleState, EmployeeIdentity>> = {
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
};

export interface RunnerTransitionInputV1 {
  taskPath: string;
  taskBytes: string;
  fromState: LifecycleState;
  result: AgentResultV1;
  receipt: PublicationReceiptV1 | null;
  checkpoint: SpecialistCheckpointV1;
}

export interface RunnerTransitionReceiptV1 {
  from_state: LifecycleState;
  to_state: LifecycleState;
  owner: EmployeeIdentity;
  task_path: string;
  evidence_path: string;
}

export class MarkdownRunnerTransitionWriter {
  constructor(private readonly companyRoot: string) {}

  async transition(input: RunnerTransitionInputV1): Promise<RunnerTransitionReceiptV1> {
    if (!input.result.next_state) throw new Error('Runner transition requires a next state.');
    const nextState = input.result.next_state;
    const nextOwner = OWNER_BY_STATE[nextState];
    const evidenceRelative = `documentation/company-runner/${input.result.task_id}/${input.checkpoint.dispatch_id.slice('sha256:'.length)}.json`;
    const evidencePath = path.resolve(this.companyRoot, evidenceRelative);
    assertWithin(path.resolve(this.companyRoot), evidencePath, 'Transition evidence');
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    const evidenceBytes = `${JSON.stringify(
      {
        schema_version: '1',
        task_id: input.result.task_id,
        role: input.result.role,
        from_state: input.fromState,
        to_state: nextState,
        summary: input.result.summary,
        evidence: input.result.evidence,
        publication: input.receipt,
        checkpoint_sha256: input.checkpoint.checkpoint_sha256,
      },
      null,
      2,
    )}\n`;
    try {
      await fs.writeFile(evidencePath, evidenceBytes, { flag: 'wx' });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await fs.readFile(evidencePath, 'utf8')) !== evidenceBytes
      )
        throw error;
    }
    let nextBytes = input.taskBytes
      .replace(/^(- \*\*Owner:\*\*\s*).+$/m, `$1${nextOwner}`)
      .replace(/^(- \*\*Current state:\*\*\s*).+$/m, `$1${nextState}`)
      .replace(/^(- \*\*Previous state:\*\*\s*).+$/m, `$1${input.fromState}`);
    if (input.receipt) {
      nextBytes = nextBytes
        .replace(/^(- \*\*Feature branch:\*\*\s*).+$/m, `$1\`${input.receipt.branch}\``)
        .replace(/^(- \*\*Current PR head commit:\*\*\s*).+$/m, `$1${input.receipt.commit_sha}`);
      if (input.receipt.pull_request) {
        nextBytes = nextBytes.replace(
          /^(- \*\*Pull Request URL\/number:\*\*\s*).+$/m,
          `$1${input.receipt.pull_request.url} (#${input.receipt.pull_request.number})`,
        );
      }
    }
    if (input.result.completion) {
      nextBytes = nextBytes
        .replace(/^(- \*\*Merge commit:\*\*\s*).+$/gm, `$1${input.result.completion.merge_sha}`)
        .replace(/^(- \*\*Pull Request state:\*\*\s*).+$/gm, '$1MERGED')
        .replace(/^(- \*\*Final GitHub Issue state:\*\*\s*).+$/gm, '$1CLOSED')
        .replace(/^(- \*\*Final Pull Request state:\*\*\s*).+$/gm, '$1MERGED');
    }
    if (nextBytes === input.taskBytes)
      throw new Error('Runner could not update authoritative task fields.');
    const row = `| ${new Date().toISOString()} | ${input.result.role} | ${nextOwner} | \`${input.fromState}\` \u2192 \`${nextState}\` | ${evidenceRelative} | Runner validated AgentResultV1, publication, and checkpoint; continue with ${nextOwner}. |`;
    nextBytes = `${nextBytes.trimEnd()}\n- **New evidence:** \`${evidenceRelative}\`\n`;
    nextBytes = nextBytes.replace(
      /(^\| --- \| --- \| --- \| --- \| --- \| --- \|\s*$)/m,
      `$1\n${row}`,
    );
    if (!nextBytes.includes(row)) throw new Error('Runner could not append the handoff row.');
    const storage = storageForLifecycleState(nextState);
    if (!storage) throw new Error(`No task storage is defined for ${nextState}.`);
    const destination = path.resolve(
      this.companyRoot,
      'tasks',
      storage,
      path.basename(input.taskPath),
    );
    assertWithin(path.resolve(this.companyRoot), destination, 'Transition task destination');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.transition`;
    await fs.writeFile(temporary, nextBytes, { flag: 'wx' });
    if (path.resolve(input.taskPath) === destination) {
      await fs.rename(temporary, destination);
    } else {
      await fs.rename(temporary, destination);
      await fs.unlink(input.taskPath);
    }
    return {
      from_state: input.fromState,
      to_state: nextState,
      owner: nextOwner,
      task_path: destination,
      evidence_path: evidenceRelative,
    };
  }
}
