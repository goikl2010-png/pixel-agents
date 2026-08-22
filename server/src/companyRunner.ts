import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPLOYEE_IDENTITIES, type EmployeeIdentity } from './actionableTaskDiscovery.js';
import {
  LIFECYCLE_STATES,
  type LifecycleState,
  storageForLifecycleState,
} from './handoffTransitionPlanner.js';

export const RUNNER_SCHEMA_VERSION = '1' as const;
export type ApprovalClass = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
export type GovernedEffect =
  | 'READ_ONLY'
  | 'FEATURE_BRANCH_CHANGE'
  | 'PR_UPDATE'
  | 'MAIN_MERGE'
  | 'ISSUE_OR_PR_CLOSE'
  | 'CREDENTIAL_OPERATION'
  | 'DEPLOY_OR_PUBLISH'
  | 'DESTRUCTIVE'
  | 'SPENDING'
  | 'PERMISSION_CHANGE'
  | 'MAJOR_SCOPE'
  | 'AMBIGUOUS';

export function evaluateGovernanceAction(
  effects: GovernedEffect[],
  permissionProfile?: string,
): ApprovalClass {
  if (permissionProfile !== 'managed-on-request') return 'UNKNOWN';
  if (effects.includes('AMBIGUOUS')) return 'UNKNOWN';
  if (
    effects.some((effect) =>
      [
        'MAIN_MERGE',
        'ISSUE_OR_PR_CLOSE',
        'CREDENTIAL_OPERATION',
        'DEPLOY_OR_PUBLISH',
        'DESTRUCTIVE',
        'SPENDING',
        'PERMISSION_CHANGE',
        'MAJOR_SCOPE',
      ].includes(effect),
    )
  )
    return 'RED';
  if (effects.includes('PR_UPDATE')) return 'YELLOW';
  return 'GREEN';
}
export type RunnerOutcome =
  | 'DISPATCHED'
  | 'DRY_RUN'
  | 'NO_ACTION_UNCHANGED'
  | 'NO_ACTION_TERMINAL'
  | 'APPROVAL_REQUIRED'
  | 'LEASE_CONTENDED'
  | 'RECOVERY_REQUIRED'
  | 'STOPPED'
  | 'FAILED';

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

export interface RunnerTask {
  id: string;
  path: string;
  bytes: string;
  state: LifecycleState;
  owner: EmployeeIdentity;
  resumeState?: LifecycleState;
  storage: 'backlog' | 'active' | 'review' | 'completed';
  evidence: string[];
}

export interface VerifiedEvidence {
  path: string;
  sha256: string;
  bytes: string;
}

export interface GitHubFacts {
  repository: string;
  issue: number;
  issueState: 'OPEN' | 'CLOSED';
  pr: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  base: string;
  branch: string;
  head: string;
}

export interface GitHubFactResolver {
  resolve(task: RunnerTask, signal: AbortSignal): Promise<GitHubFacts>;
}

export interface GhCliResolverOptions {
  executable?: 'gh' | 'gh.exe';
  credentialEnvironmentVariable: 'GH_TOKEN' | 'GITHUB_TOKEN';
  parentEnvironment?: NodeJS.ProcessEnv;
  run?: typeof runGhJson;
}

export class GhCliGitHubFactResolver implements GitHubFactResolver {
  constructor(private readonly options: GhCliResolverOptions) {}
  async resolve(task: RunnerTask, signal: AbortSignal): Promise<GitHubFacts> {
    const expected = taskDeliveryFields(task);
    if (!expected.repository || !expected.issue || !expected.pr)
      throw new Error('Authoritative task lacks repository, Issue, or PR identity.');
    const executable = this.options.executable ?? (process.platform === 'win32' ? 'gh.exe' : 'gh');
    if (!['gh', 'gh.exe'].includes(executable))
      throw new Error('GitHub fact resolver executable is not allowlisted.');
    const environment = buildGovernedChildEnvironment(
      this.options.parentEnvironment ?? process.env,
      this.options.credentialEnvironmentVariable,
    );
    const run = this.options.run ?? runGhJson;
    const [issue, pr] = await Promise.all([
      run(
        executable,
        ['api', `repos/${expected.repository}/issues/${expected.issue}`],
        environment,
        signal,
      ),
      run(
        executable,
        ['api', `repos/${expected.repository}/pulls/${expected.pr}`],
        environment,
        signal,
      ),
    ]);
    const issueObject = issue as { state?: string };
    const prObject = pr as {
      state?: string;
      draft?: boolean;
      merged_at?: string | null;
      base?: { ref?: string };
      head?: { ref?: string; sha?: string };
    };
    if (
      !['open', 'closed'].includes(issueObject.state ?? '') ||
      !['open', 'closed'].includes(prObject.state ?? '') ||
      typeof prObject.draft !== 'boolean' ||
      !prObject.base?.ref ||
      !prObject.head?.ref ||
      !/^[0-9a-f]{40}$/i.test(prObject.head.sha ?? '')
    )
      throw new Error('GitHub returned malformed or incomplete action-required facts.');
    return {
      repository: expected.repository,
      issue: expected.issue,
      issueState: issueObject.state === 'open' ? 'OPEN' : 'CLOSED',
      pr: expected.pr,
      prState: prObject.merged_at ? 'MERGED' : prObject.state === 'open' ? 'OPEN' : 'CLOSED',
      draft: prObject.draft,
      base: prObject.base.ref,
      branch: prObject.head.ref,
      head: prObject.head.sha!,
    };
  }
}

export interface ReconciledFacts {
  evidence: VerifiedEvidence[];
  github?: GitHubFacts;
  permissionProfile: 'managed-on-request';
}

export interface RunnerDecision {
  schema_version: '1';
  task_id: string;
  task_path: string;
  state: LifecycleState;
  owner: EmployeeIdentity;
  action_kind: 'DISPATCH_ROLE' | 'STOP_TERMINAL' | 'AWAIT_ALEX_DECISION';
  classification: ApprovalClass;
  state_fingerprint: string;
  dispatch_id: string;
  reason: string;
  affected_resources: string[];
  external_effects: string[];
  github?: GitHubFacts;
}

export interface HandoffPacket {
  schema_version: '1';
  task: { id: string; path: string; fingerprint: string };
  role: EmployeeIdentity;
  state: LifecycleState;
  dispatch_id: string;
  evidence: string[];
  instruction: string;
}

export interface DispatchResult {
  exitCode: number | null;
  timedOut: boolean;
  model: string | 'unknown';
  inputTokens: number | 'unknown';
  outputTokens: number | 'unknown';
  launched: boolean;
  output?: string;
}

export interface AgentDispatcher {
  dispatch(packet: HandoffPacket, signal: AbortSignal): Promise<DispatchResult>;
}

export class FakeAgentDispatcher implements AgentDispatcher {
  calls: HandoffPacket[] = [];
  constructor(
    private readonly result: DispatchResult = {
      exitCode: 0,
      timedOut: false,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      launched: true,
    },
  ) {}
  async dispatch(packet: HandoffPacket, _signal: AbortSignal): Promise<DispatchResult> {
    this.calls.push(packet);
    return this.result;
  }
}

export interface CodexDispatcherOptions {
  executable: string;
  workingRoot: string;
  approvedWorkingRoot?: string;
  allowedExecutable: string;
  outputSchemaPath: string;
  timeoutMs: number;
  credentialEnvironmentVariable: 'GH_TOKEN' | 'GITHUB_TOKEN';
  parentEnvironment?: NodeJS.ProcessEnv;
  versionProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  globalCapabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  capabilityProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  spawnProcess?: typeof spawnGovernedProcess;
}

const FORBIDDEN_ARGUMENT =
  /(^|\s)(--dangerously-bypass|--full-auto|--sandbox\s+danger-full-access|--config|--ask-for-approval\s+never)($|\s)/i;

export class CodexAgentDispatcher implements AgentDispatcher {
  constructor(private readonly options: CodexDispatcherOptions) {}

  async dispatch(packet: HandoffPacket, signal: AbortSignal): Promise<DispatchResult> {
    const executable = path.resolve(this.options.executable);
    if (executable !== path.resolve(this.options.allowedExecutable))
      throw new Error('Configured Codex executable is not allowlisted.');
    if (!path.isAbsolute(this.options.workingRoot))
      throw new Error('Codex working root must be absolute.');
    if (!this.options.approvedWorkingRoot || !path.isAbsolute(this.options.approvedWorkingRoot))
      throw new Error('An explicit absolute approved Codex working root is required.');
    const root = await fs.realpath(this.options.workingRoot);
    const approved = await fs.realpath(this.options.approvedWorkingRoot);
    const parsed = path.parse(approved);
    if (approved === parsed.root || approved.split(path.sep).filter(Boolean).length < 2)
      throw new Error('Broad filesystem roots are not approved Codex working roots.');
    const relative = path.relative(approved, root);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Codex working root escapes the approved root.');
    const childEnvironment = buildGovernedChildEnvironment(
      this.options.parentEnvironment ?? process.env,
      this.options.credentialEnvironmentVariable,
    );
    const probeEnvironment = { ...childEnvironment };
    delete probeEnvironment[this.options.credentialEnvironmentVariable];
    const version = await (this.options.versionProbe ?? probeCodexVersion)(
      executable,
      probeEnvironment,
    );
    if (!/codex-cli\s+0\.(?:1(?:4[8-9]|[5-9]\d)|[2-9]\d\d)\./i.test(version))
      throw new Error(`Unsupported Codex CLI capability version: ${version}`);
    const globalCapabilities = await (
      this.options.globalCapabilityProbe ?? probeCodexGlobalCapabilities
    )(executable, probeEnvironment);
    if (
      !globalCapabilities
        .split(/\r?\n/)
        .some((line) => line.trim().includes('--ask-for-approval <APPROVAL_POLICY>'))
    )
      throw new Error(
        'Unsupported Codex CLI global capability surface: missing --ask-for-approval <APPROVAL_POLICY>.',
      );
    const execCapabilities = await (this.options.capabilityProbe ?? probeCodexCapabilities)(
      executable,
      probeEnvironment,
    );
    for (const capability of [
      '--json',
      '--output-schema <FILE>',
      '--cd <DIR>',
      '--sandbox <SANDBOX_MODE>',
    ]) {
      if (!execCapabilities.split(/\r?\n/).some((line) => line.trim().includes(capability)))
        throw new Error(`Unsupported Codex CLI exec capability surface: missing ${capability}.`);
    }
    const outputSchema = await fs.realpath(this.options.outputSchemaPath);
    const schemaRelative = path.relative(approved, outputSchema);
    if (schemaRelative.startsWith('..') || path.isAbsolute(schemaRelative))
      throw new Error('Codex output schema escapes the approved working root.');
    const schema = JSON.parse(await fs.readFile(outputSchema, 'utf8')) as unknown;
    validateJsonSchemaDefinition(schema);
    const prompt = JSON.stringify(packet);
    const args = [
      '--ask-for-approval',
      'on-request',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--cd',
      root,
      '--output-schema',
      outputSchema,
      prompt,
    ];
    if (
      args.some((argument) => FORBIDDEN_ARGUMENT.test(argument)) ||
      args.includes('--approve-for-me') ||
      args[0] !== '--ask-for-approval' ||
      args[1] !== 'on-request' ||
      args[2] !== 'exec'
    )
      throw new Error('Codex invocation contains a forbidden permission or bypass argument.');
    const result = await (this.options.spawnProcess ?? spawnGovernedProcess)(
      executable,
      args,
      root,
      this.options.timeoutMs,
      signal,
      childEnvironment,
    );
    if (!result.output) throw new Error('Codex returned no JSONL output.');
    validateCodexJsonlOutput(result.output);
    return result;
  }
}

const CREDENTIAL_ALLOWLIST = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
const SAFE_PARENT_ENVIRONMENT = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
] as const;

function environmentEntries(parent: NodeJS.ProcessEnv, wanted: string): Array<[string, string]> {
  return Object.entries(parent).filter(
    (entry): entry is [string, string] =>
      entry[0].toUpperCase() === wanted.toUpperCase() && entry[1] !== undefined,
  );
}

/** Builds the only environment permitted at the governed agent boundary.
 * The returned credential value is intentionally never serialized or exposed
 * by Runner results, audit, status, approval, prompts, arguments, or errors. */
export function buildGovernedChildEnvironment(
  parent: NodeJS.ProcessEnv,
  credentialVariable: 'GH_TOKEN' | 'GITHUB_TOKEN',
): NodeJS.ProcessEnv {
  if (!CREDENTIAL_ALLOWLIST.includes(credentialVariable))
    throw new Error('Configured GitHub credential source is not allowlisted.');
  const selected = environmentEntries(parent, credentialVariable);
  const other = CREDENTIAL_ALLOWLIST.flatMap((name) =>
    name === credentialVariable ? [] : environmentEntries(parent, name),
  );
  if (selected.length !== 1 || selected[0][1].trim().length === 0)
    throw new Error('Governed GitHub credential is absent, empty, or ambiguous.');
  if (other.length > 0)
    throw new Error('Conflicting governed GitHub credential sources are present.');

  const child: NodeJS.ProcessEnv = {};
  for (const name of SAFE_PARENT_ENVIRONMENT) {
    const matches = environmentEntries(parent, name);
    if (matches.length > 1) throw new Error(`Ambiguous inherited environment key ${name}.`);
    if (matches.length === 1) child[name] = matches[0][1];
  }
  child[credentialVariable] = selected[0][1];
  composeOpenSslGitConfiguration(parent, child);
  return child;
}

function composeOpenSslGitConfiguration(parent: NodeJS.ProcessEnv, child: NodeJS.ProcessEnv): void {
  const countEntries = environmentEntries(parent, 'GIT_CONFIG_COUNT');
  if (countEntries.length > 1) throw new Error('Ambiguous inherited Git configuration count.');
  const countText = countEntries[0]?.[1] ?? '0';
  if (!/^\d+$/.test(countText)) throw new Error('Malformed inherited Git configuration count.');
  const count = Number(countText);
  let hasOpenSsl = false;
  for (let index = 0; index < count; index++) {
    const key = environmentEntries(parent, `GIT_CONFIG_KEY_${index}`);
    const value = environmentEntries(parent, `GIT_CONFIG_VALUE_${index}`);
    if (key.length !== 1 || value.length !== 1)
      throw new Error('Incomplete or ambiguous inherited Git configuration.');
    if (key[0][1].toLowerCase() === 'http.sslbackend') {
      if (value[0][1].toLowerCase() !== 'openssl')
        throw new Error('Inherited Git TLS backend conflicts with governed OpenSSL transport.');
      hasOpenSsl = true;
    }
    child[`GIT_CONFIG_KEY_${index}`] = key[0][1];
    child[`GIT_CONFIG_VALUE_${index}`] = value[0][1];
  }
  child.GIT_CONFIG_COUNT = String(hasOpenSsl ? count : count + 1);
  if (!hasOpenSsl) {
    child[`GIT_CONFIG_KEY_${count}`] = 'http.sslBackend';
    child[`GIT_CONFIG_VALUE_${count}`] = 'openssl';
  }
}

async function probeCodexVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      env: environment,
      shell: false,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error('Codex version probe failed.')),
    );
  });
}

async function probeCodexCapabilities(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['exec', '--help'], {
      env: environment,
      shell: false,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.stderr.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(`exec\n${output}`) : reject(new Error('Codex capability probe failed.')),
    );
  });
}

async function probeCodexGlobalCapabilities(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--help'], {
      env: environment,
      shell: false,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error('Codex global capability probe failed.')),
    );
  });
}

async function runGhJson(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      signal,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.once('error', () => reject(new Error('GitHub fact resolver failed before completion.')));
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error('GitHub fact resolver returned a nonzero status.'));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('GitHub fact resolver returned malformed JSON.'));
      }
    });
  });
}

export async function spawnGovernedProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString('utf8')));
    let settled = false;
    let timedOut = false;
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', terminate);
      resolve(result);
    };
    const terminate = (): void => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), Math.min(5_000, timeoutMs));
    };
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(terminate, timeoutMs);
    signal.addEventListener('abort', terminate, { once: true });
    child.once('error', reject);
    child.once('close', (code) =>
      finish({
        exitCode: code,
        timedOut,
        model: 'unknown',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        launched: true,
        output,
      }),
    );
  });
}

function validateCodexJsonlOutput(output: string): void {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error('Codex returned empty JSONL output.');
  const records = lines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error('Codex returned malformed JSONL output.');
    }
  });
  const messages = records.filter(
    (record) =>
      record.type === 'item.completed' &&
      record.item &&
      typeof record.item === 'object' &&
      (record.item as Record<string, unknown>).type === 'agent_message',
  );
  if (messages.length !== 1)
    throw new Error('Codex JSONL output lacks one unique final agent message.');
  const text = (messages[0].item as Record<string, unknown>).text;
  let final: Record<string, unknown>;
  try {
    final = JSON.parse(String(text)) as Record<string, unknown>;
  } catch {
    throw new Error('Codex final output is malformed JSON.');
  }
  if (
    Object.keys(final).some((key) => key !== 'outcome') ||
    !['completed', 'blocked', 'failed'].includes(String(final.outcome))
  )
    throw new Error('Codex final output failed the governed output schema.');
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function field(markdown: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ...markdown.matchAll(new RegExp(`^\\s*-?\\s*\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, 'gim')),
  ].map((match) => match[1].trim().replace(/^`|`$/g, ''));
}

export async function readRunnerTask(companyRoot: string, taskId: string): Promise<RunnerTask> {
  if (!/^TASK-\d+$/.test(taskId)) throw new Error('Task ID must use TASK-<digits>.');
  const taskRoot = path.resolve(companyRoot, 'tasks');
  const stores = ['backlog', 'active', 'review', 'completed'] as const;
  const matches: Array<{ file: string; storage: (typeof stores)[number]; bytes: string }> = [];
  for (const storage of stores) {
    const directory = path.join(taskRoot, storage);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.toLowerCase().endsWith('.md')).sort()) {
      const file = path.join(directory, name);
      const bytes = await fs.readFile(file, 'utf8');
      if (field(bytes, 'Task ID').includes(taskId)) matches.push({ file, storage, bytes });
    }
  }
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one authoritative ${taskId} record; found ${matches.length}.`,
    );
  const match = matches[0];
  const one = (name: string): string => {
    const values = field(match.bytes, name);
    if (values.length !== 1) throw new Error(`${taskId} requires exactly one ${name} field.`);
    return values[0];
  };
  const state = one('Current state');
  const owner = one('Owner');
  if (!LIFECYCLE_STATES.includes(state as LifecycleState) || state === 'FAILED')
    throw new Error(`Unsupported lifecycle state ${JSON.stringify(state)}.`);
  if (!EMPLOYEE_IDENTITIES.includes(owner as EmployeeIdentity))
    throw new Error(`Unsupported owner ${JSON.stringify(owner)}.`);
  const lifecycleState = state as LifecycleState;
  const employee = owner as EmployeeIdentity;
  if (OWNER_BY_STATE[lifecycleState] !== employee)
    throw new Error(`${lifecycleState} must be owned by ${OWNER_BY_STATE[lifecycleState]}.`);
  const expectedStorage = storageForLifecycleState(lifecycleState);
  if (lifecycleState !== 'BLOCKED' && expectedStorage !== match.storage)
    throw new Error(
      `${lifecycleState} must be stored in ${expectedStorage}, not ${match.storage}.`,
    );
  const resumeRaw = one('Resume state (required only when BLOCKED)');
  const resumeState = resumeRaw === 'None' ? undefined : (resumeRaw as LifecycleState);
  if (
    lifecycleState === 'BLOCKED' &&
    (!resumeState ||
      !LIFECYCLE_STATES.includes(resumeState) ||
      ['BLOCKED', 'COMPLETED'].includes(resumeState))
  )
    throw new Error('BLOCKED requires an exact valid nonterminal Resume state.');
  if (lifecycleState !== 'BLOCKED' && resumeState)
    throw new Error('Resume state is valid only for BLOCKED.');
  const evidence = [
    ...new Set(
      [...match.bytes.matchAll(/`((?:documentation|tasks)[^`]+)`/g)].map((item) => item[1]),
    ),
  ].sort();
  return {
    id: taskId,
    path: path.resolve(match.file),
    bytes: match.bytes,
    state: lifecycleState,
    owner: employee,
    ...(resumeState ? { resumeState } : {}),
    storage: match.storage,
    evidence,
  };
}

function canonicalFactBytes(facts?: ReconciledFacts): string {
  if (!facts) return '';
  return JSON.stringify({
    evidence: facts.evidence.map(({ path: file, sha256: hash }) => ({ path: file, sha256: hash })),
    github: facts.github,
    permission_profile: facts.permissionProfile,
  });
}

function taskDeliveryFields(task: RunnerTask): Partial<GitHubFacts> {
  const oneOptional = (name: string): string | undefined => {
    const values = field(task.bytes, name).filter((value) => !/pending|n\/a/i.test(value));
    if (values.length > 1) throw new Error(`Conflicting ${name} fields.`);
    return values[0];
  };
  const numberFrom = (value?: string): number | undefined => {
    const match = value?.match(/#?(\d+)/);
    return match ? Number(match[1]) : undefined;
  };
  return {
    repository: oneOptional('Repository'),
    issue: numberFrom(oneOptional('GitHub Issue URL/number')),
    pr: numberFrom(oneOptional('Pull Request URL/number')),
    base: oneOptional('Base branch'),
    branch: oneOptional('Feature branch'),
    head: oneOptional('Current PR head commit'),
  };
}

export async function reconcileRunnerFacts(
  companyRoot: string,
  task: RunnerTask,
  resolver?: GitHubFactResolver,
  signal: AbortSignal = new AbortController().signal,
): Promise<ReconciledFacts> {
  const seen = new Set<string>();
  const evidence: VerifiedEvidence[] = [];
  for (const linked of task.evidence) {
    const normalized = linked.replace(/\\/g, '/');
    if (seen.has(normalized)) throw new Error(`Duplicate evidence pointer ${normalized}.`);
    seen.add(normalized);
    const absolute = path.resolve(companyRoot, normalized);
    const relative = path.relative(path.resolve(companyRoot), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Evidence path escapes company root: ${normalized}.`);
    let bytes: string;
    try {
      bytes = await fs.readFile(absolute, 'utf8');
    } catch {
      throw new Error(`Required evidence is missing or unreadable: ${normalized}.`);
    }
    evidence.push({ path: normalized, sha256: sha256(bytes), bytes });
  }
  evidence.sort((a, b) => a.path.localeCompare(b.path));
  if (task.state !== 'BACKLOG' && task.state !== 'COMPLETED' && evidence.length === 0)
    throw new Error(`Required evidence is absent for ${task.state}.`);

  let github: GitHubFacts | undefined;
  if (task.state !== 'COMPLETED') {
    if (!resolver) throw new Error('Action-required live GitHub facts are unavailable.');
    github = await resolver.resolve(task, signal);
    const expected = taskDeliveryFields(task);
    for (const key of ['repository', 'issue', 'pr', 'base', 'branch', 'head'] as const) {
      if (expected[key] !== undefined && expected[key] !== github[key])
        throw new Error(`Live GitHub ${key} conflicts with the authoritative task.`);
    }
    if (github.issueState !== 'OPEN') throw new Error('Action-required GitHub Issue is not OPEN.');
    if (github.prState !== 'OPEN' && task.state !== 'BACKLOG')
      throw new Error('Action-required Pull Request is not OPEN.');
    if (['READY_FOR_REVIEW', 'REVIEW', 'APPROVED'].includes(task.state)) {
      const covering = evidence.filter(
        (item) => item.bytes.includes(github!.head) && /\bPASSED\b/i.test(item.bytes),
      );
      if (covering.length !== 1)
        throw new Error('Exactly one current-head PASSED QA evidence record is required.');
    }
    if (task.state === 'CHANGES_REQUIRED') {
      const covering = evidence.filter(
        (item) => item.bytes.includes(github!.head) && /CHANGES REQUIRED/i.test(item.bytes),
      );
      if (covering.length !== 1)
        throw new Error('Exactly one current-head CHANGES REQUIRED evidence record is required.');
    }
  }
  return { evidence, ...(github ? { github } : {}), permissionProfile: 'managed-on-request' };
}

export function decideRunnerAction(task: RunnerTask, facts?: ReconciledFacts): RunnerDecision {
  const fingerprint = sha256(
    `${task.path.replace(/\\/g, '/')}\n${task.bytes}\n${canonicalFactBytes(facts)}`,
  );
  let action: RunnerDecision['action_kind'] = 'DISPATCH_ROLE';
  const contemplated: GovernedEffect[] =
    task.state === 'APPROVED'
      ? ['MAIN_MERGE', 'ISSUE_OR_PR_CLOSE']
      : task.state === 'BLOCKED'
        ? ['AMBIGUOUS']
        : ['READ_ONLY'];
  let classification: ApprovalClass = evaluateGovernanceAction(
    contemplated,
    facts?.permissionProfile,
  );
  let reason = `Dispatch the role that owns ${task.state}; the role remains responsible for evidence and transition decisions.`;
  const affectedResources = [task.path, ...(facts?.evidence.map((item) => item.path) ?? [])];
  const externalEffects = facts?.github
    ? [`Read GitHub Issue #${facts.github.issue} and PR #${facts.github.pr}`]
    : [];
  if (task.state === 'COMPLETED') {
    action = 'STOP_TERMINAL';
    reason = 'COMPLETED is terminal.';
  } else if (task.state === 'APPROVED' || task.state === 'BLOCKED') {
    action = 'AWAIT_ALEX_DECISION';
    classification = task.state === 'APPROVED' ? 'RED' : 'UNKNOWN';
    reason = `${task.state} requires a consequential or unresolved Alex decision; Runner stops.`;
  }
  const dispatchId = sha256(
    `company-runner-v1\n${task.id}\n${task.state}\n${task.owner}\n${action}\n${fingerprint}`,
  );
  return {
    schema_version: RUNNER_SCHEMA_VERSION,
    task_id: task.id,
    task_path: task.path,
    state: task.state,
    owner: task.owner,
    action_kind: action,
    classification,
    state_fingerprint: fingerprint,
    dispatch_id: dispatchId,
    reason,
    affected_resources: affectedResources,
    external_effects: externalEffects,
    ...(facts?.github ? { github: facts.github } : {}),
  };
}

export interface ApprovalPackage {
  schema_version: '1';
  request_id: string;
  created_at: string;
  agent: EmployeeIdentity;
  task: { id: string; path: string; fingerprint: string };
  workflow_state: LifecycleState;
  requested_action: string;
  reason: string;
  affected_files_resources: string[];
  branch_pr: { repository: string; branch: string; pr: number | null; head: string };
  external_effects: string[];
  risk_approval_class: 'YELLOW' | 'RED' | 'UNKNOWN';
  recommended_next_action: string;
  evidence: string[];
  run_id: string;
  dispatch_id: string;
}

export function approvalPackage(
  decision: RunnerDecision,
  runId: string,
  evidence: string[],
): ApprovalPackage {
  if (decision.classification === 'GREEN')
    throw new Error('Approval package requires a non-GREEN classification.');
  return {
    schema_version: RUNNER_SCHEMA_VERSION,
    request_id: sha256(`${runId}\n${decision.dispatch_id}\n${decision.classification}`),
    created_at: new Date().toISOString(),
    agent: decision.owner,
    task: {
      id: decision.task_id,
      path: decision.task_path,
      fingerprint: decision.state_fingerprint,
    },
    workflow_state: decision.state,
    requested_action: decision.action_kind,
    reason: decision.reason,
    affected_files_resources: decision.affected_resources,
    branch_pr: decision.github
      ? {
          repository: decision.github.repository,
          branch: decision.github.branch,
          pr: decision.github.pr,
          head: decision.github.head,
        }
      : {
          repository: 'local-company-record',
          branch: 'not-applicable',
          pr: null,
          head: 'not-applicable',
        },
    external_effects: decision.external_effects,
    risk_approval_class: decision.classification,
    recommended_next_action:
      'Alex/Goi decision and fresh evidence required; do not dispatch automatically.',
    evidence,
    run_id: runId,
    dispatch_id: decision.dispatch_id,
  };
}

export function validateApprovalPackage(value: ApprovalPackage): void {
  const sha = /^sha256:[0-9a-f]{64}$/;
  if (
    value.schema_version !== '1' ||
    !sha.test(value.request_id) ||
    !sha.test(value.task.fingerprint) ||
    !sha.test(value.dispatch_id) ||
    !/^TASK-\d+$/.test(value.task.id) ||
    !EMPLOYEE_IDENTITIES.includes(value.agent) ||
    !LIFECYCLE_STATES.includes(value.workflow_state) ||
    !['YELLOW', 'RED', 'UNKNOWN'].includes(value.risk_approval_class) ||
    !value.requested_action ||
    !value.reason ||
    !value.recommended_next_action ||
    !value.run_id ||
    value.affected_files_resources.length === 0 ||
    !value.branch_pr.repository ||
    !value.branch_pr.branch ||
    !value.branch_pr.head ||
    Number.isNaN(Date.parse(value.created_at))
  )
    throw new Error('Approval package failed the checked contract.');
}

export async function validateApprovalPackageSchema(
  value: ApprovalPackage,
  schemaPath: string,
): Promise<void> {
  let schema: unknown;
  try {
    schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as unknown;
  } catch {
    throw new Error('Approval package schema is missing, unreadable, or malformed.');
  }
  validateJsonSchemaDefinition(schema);
  const errors: string[] = [];
  validateJsonSchemaValue(schema as JsonSchema, value, '$', errors);
  if (errors.length) throw new Error(`Approval package failed checked-in schema: ${errors[0]}`);
}

type JsonSchema = Record<string, unknown>;
const SCHEMA_KEYS = new Set([
  '$schema',
  'title',
  'type',
  'additionalProperties',
  'required',
  'properties',
  'const',
  'enum',
  'pattern',
  'format',
  'minLength',
  'minimum',
  'minItems',
  'uniqueItems',
  'items',
  'oneOf',
]);

function validateJsonSchemaDefinition(schema: unknown, at = '$'): asserts schema is JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error(`Invalid JSON Schema at ${at}.`);
  for (const key of Object.keys(schema))
    if (!SCHEMA_KEYS.has(key)) throw new Error(`Unsupported JSON Schema keyword ${key} at ${at}.`);
  const typed = schema as JsonSchema;
  if (typed.type !== undefined) {
    const types = Array.isArray(typed.type) ? typed.type : [typed.type];
    if (
      !types.every((type) =>
        ['object', 'array', 'string', 'integer', 'number', 'null'].includes(String(type)),
      )
    )
      throw new Error(`Invalid JSON Schema type at ${at}.`);
  }
  if (
    typed.required !== undefined &&
    (!Array.isArray(typed.required) || !typed.required.every((item) => typeof item === 'string'))
  )
    throw new Error(`Invalid JSON Schema required list at ${at}.`);
  if (typed.properties !== undefined) {
    if (
      !typed.properties ||
      typeof typed.properties !== 'object' ||
      Array.isArray(typed.properties)
    )
      throw new Error(`Invalid JSON Schema properties at ${at}.`);
    for (const [key, child] of Object.entries(typed.properties))
      validateJsonSchemaDefinition(child, `${at}.properties.${key}`);
  }
  if (typed.items !== undefined) validateJsonSchemaDefinition(typed.items, `${at}.items`);
  if (typed.oneOf !== undefined) {
    if (!Array.isArray(typed.oneOf) || typed.oneOf.length === 0)
      throw new Error(`Invalid JSON Schema oneOf at ${at}.`);
    typed.oneOf.forEach((child, index) =>
      validateJsonSchemaDefinition(child, `${at}.oneOf[${index}]`),
    );
  }
  if (typed.pattern !== undefined) {
    try {
      new RegExp(String(typed.pattern));
    } catch {
      throw new Error(`Invalid JSON Schema pattern at ${at}.`);
    }
  }
}

function validateJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
  at: string,
  errors: string[],
): void {
  if (schema.oneOf) {
    const matches = (schema.oneOf as JsonSchema[]).filter((candidate) => {
      const candidateErrors: string[] = [];
      validateJsonSchemaValue(candidate, value, at, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at} must match exactly one schema`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at} must equal const`);
  if (schema.enum && !(schema.enum as unknown[]).includes(value))
    errors.push(`${at} is not in enum`);
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value;
  if (
    types.length &&
    !types.includes(actual) &&
    !(actual === 'integer' && types.includes('number'))
  ) {
    errors.push(`${at} has invalid type`);
    return;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < Number(schema.minLength))
      errors.push(`${at} is too short`);
    if (schema.pattern !== undefined && !new RegExp(String(schema.pattern)).test(value))
      errors.push(`${at} fails pattern`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value)))
      errors.push(`${at} is not date-time`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < Number(schema.minimum))
    errors.push(`${at} is below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < Number(schema.minItems))
      errors.push(`${at} has too few items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      errors.push(`${at} has duplicate items`);
    if (schema.items)
      value.forEach((item, index) =>
        validateJsonSchemaValue(schema.items as JsonSchema, item, `${at}[${index}]`, errors),
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const required of (schema.required as string[] | undefined) ?? [])
      if (!(required in object)) errors.push(`${at}.${required} is required`);
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    if (schema.additionalProperties === false)
      for (const key of Object.keys(object))
        if (!(key in properties)) errors.push(`${at}.${key} is additional`);
    for (const [key, child] of Object.entries(properties))
      if (key in object) validateJsonSchemaValue(child, object[key], `${at}.${key}`, errors);
  }
}

interface LedgerEvent {
  schema_version: '1';
  sequence: number;
  timestamp: string;
  type: string;
  run_id: string;
  dispatch_id: string;
  task_fingerprint: string;
  outcome: string;
  previous_hash: string;
  event_hash: string;
  details: Record<string, unknown>;
}

export class RunnerLedger {
  constructor(readonly file: string) {}
  async read(): Promise<LedgerEvent[]> {
    let data: string;
    try {
      data = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = data.split(/\r?\n/).filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as LedgerEvent);
    let previous = 'GENESIS';
    events.forEach((event, index) => {
      const { event_hash, ...body } = event;
      if (
        event.sequence !== index + 1 ||
        event.previous_hash !== previous ||
        sha256(JSON.stringify(body)) !== event_hash
      )
        throw new Error('Runner ledger integrity failure.');
      previous = event_hash;
    });
    return events;
  }
  async append(
    input: Omit<
      LedgerEvent,
      'schema_version' | 'sequence' | 'timestamp' | 'previous_hash' | 'event_hash'
    >,
  ): Promise<LedgerEvent> {
    const events = await this.read();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const body = {
      schema_version: RUNNER_SCHEMA_VERSION,
      sequence: events.length + 1,
      timestamp: new Date().toISOString(),
      ...input,
      previous_hash: events.at(-1)?.event_hash ?? 'GENESIS',
    };
    const event = { ...body, event_hash: sha256(JSON.stringify(body)) };
    await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    return event;
  }
}

interface Lease {
  task_id: string;
  run_id: string;
  dispatch_id: string;
  pid: number;
  host: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  state_fingerprint: string;
}
export class TaskLease {
  constructor(
    readonly file: string,
    private readonly ttlMs = 30_000,
  ) {}
  async acquire(
    decision: RunnerDecision,
    runId: string,
  ): Promise<'acquired' | 'contended' | 'recovered'> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const now = Date.now();
    const lease: Lease = {
      task_id: decision.task_id,
      run_id: runId,
      dispatch_id: decision.dispatch_id,
      pid: process.pid,
      host: os.hostname(),
      acquired_at: new Date(now).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
      state_fingerprint: decision.state_fingerprint,
    };
    try {
      const handle = await fs.open(
        this.file,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      await handle.writeFile(JSON.stringify(lease));
      await handle.close();
      return 'acquired';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = JSON.parse(await fs.readFile(this.file, 'utf8')) as Lease;
    if (
      Date.parse(existing.expires_at) >= now ||
      existing.host !== os.hostname() ||
      isProcessAlive(existing.pid)
    )
      return 'contended';
    const stale = `${this.file}.stale-${existing.run_id}`;
    await fs.rename(this.file, stale);
    try {
      const handle = await fs.open(
        this.file,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      await handle.writeFile(JSON.stringify(lease));
      await handle.close();
      return 'recovered';
    } catch (error) {
      await fs.rename(stale, this.file).catch(() => undefined);
      throw error;
    }
  }
  async release(runId: string): Promise<void> {
    let lease: Lease;
    try {
      lease = JSON.parse(await fs.readFile(this.file, 'utf8')) as Lease;
    } catch {
      return;
    }
    if (lease.run_id !== runId) throw new Error('Lease release refused: owner mismatch.');
    await fs.unlink(this.file);
  }
  async renew(runId: string): Promise<void> {
    const handle = await fs.open(this.file, 'r+');
    try {
      const lease = JSON.parse(await handle.readFile('utf8')) as Lease;
      if (lease.run_id !== runId) throw new Error('Lease heartbeat refused: owner mismatch.');
      const now = Date.now();
      const renewed = JSON.stringify({
        ...lease,
        heartbeat_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.ttlMs).toISOString(),
      });
      await handle.truncate(0);
      await handle.write(renewed, 0, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = JSON.parse(await fs.readFile(this.file, 'utf8')) as Lease;
    if (current.run_id !== runId) throw new Error('Lease ownership changed during heartbeat.');
  }
  async bind(runId: string, decision: RunnerDecision): Promise<void> {
    const lease = JSON.parse(await fs.readFile(this.file, 'utf8')) as Lease;
    if (lease.run_id !== runId) throw new Error('Lease identity bind refused: owner mismatch.');
    const bound = {
      ...lease,
      dispatch_id: decision.dispatch_id,
      state_fingerprint: decision.state_fingerprint,
    };
    const temporary = `${this.file}.${runId}.bind`;
    await fs.writeFile(temporary, JSON.stringify(bound), { flag: 'wx' });
    const current = JSON.parse(await fs.readFile(this.file, 'utf8')) as Lease;
    if (current.run_id !== runId) {
      await fs.unlink(temporary).catch(() => undefined);
      throw new Error('Lease ownership changed during identity bind.');
    }
    await fs.rename(temporary, this.file);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunOnceOptions {
  companyRoot: string;
  taskId: string;
  stateDirectory: string;
  dispatcher: AgentDispatcher;
  dryRun?: boolean;
  githubResolver?: GitHubFactResolver;
  stopFile?: string;
  timeoutMs?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  circuitFailureThreshold?: number;
  signal?: AbortSignal;
  approvalSchemaPath?: string;
}
export interface RunOnceResult {
  run_id: string;
  outcome: RunnerOutcome;
  decision: RunnerDecision;
  dispatch?: DispatchResult;
  approval?: ApprovalPackage;
}

export class TransientPrelaunchError extends Error {}

const LEGAL_NEXT: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  BACKLOG: ['DEVELOPMENT', 'BLOCKED'],
  DEVELOPMENT: ['READY_FOR_QA', 'BLOCKED'],
  READY_FOR_QA: ['QA', 'BLOCKED'],
  QA: ['READY_FOR_REVIEW', 'CHANGES_REQUIRED', 'BLOCKED'],
  CHANGES_REQUIRED: ['QA_RETEST', 'BLOCKED'],
  QA_RETEST: ['READY_FOR_REVIEW', 'CHANGES_REQUIRED', 'BLOCKED'],
  READY_FOR_REVIEW: ['REVIEW', 'BLOCKED'],
  REVIEW: ['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED'],
  APPROVED: ['COMPLETED', 'BLOCKED'],
  COMPLETED: [],
  BLOCKED: [],
};

export function isLegalRunnerTransition(before: RunnerTask, after: RunnerTask): boolean {
  return before.state === 'BLOCKED'
    ? before.resumeState === after.state
    : LEGAL_NEXT[before.state].includes(after.state);
}

async function verifyObservedTransition(
  companyRoot: string,
  before: RunnerTask,
  after: RunnerTask,
  facts: ReconciledFacts,
): Promise<void> {
  const expectedActor = before.owner;
  const newlyLinked = facts.evidence.filter((item) => !before.evidence.includes(item.path));
  if (newlyLinked.length !== 1)
    throw new Error('Observed transition requires exactly one newly linked evidence record.');
  const evidence = newlyLinked[0];
  const taskStat = await fs.stat(after.path);
  const evidenceStat = await fs.stat(path.resolve(companyRoot, evidence.path));
  if (evidenceStat.mtimeMs > taskStat.mtimeMs)
    throw new Error('Transition evidence was saved after the authoritative transition.');
  const transition = `${before.state} to ${after.state}`;
  if (!evidence.bytes.includes(expectedActor) || !evidence.bytes.includes(transition))
    throw new Error('Transition evidence has the wrong role or transition type.');
  if (facts.github && !evidence.bytes.includes(facts.github.head))
    throw new Error('Transition evidence does not cover the current Pull Request head.');
  const matchingRows = [...after.bytes.matchAll(/^\|[^\n]+\|/gm)].filter(
    ([row]) =>
      row.includes(expectedActor) &&
      row.includes(`\`${before.state}\` to \`${after.state}\``) &&
      row.includes(evidence.path),
  );
  if (matchingRows.length !== 1)
    throw new Error('Authoritative task lacks one unique role-owned transition handoff row.');
}

export async function runCompanyOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const runId = randomUUID();
  const task = await readRunnerTask(options.companyRoot, options.taskId);
  let decision = decideRunnerAction(task);
  const ledger = new RunnerLedger(path.join(options.stateDirectory, `${task.id}.jsonl`));
  const append = (type: string, outcome: string, details: Record<string, unknown> = {}) =>
    ledger.append({
      type,
      run_id: runId,
      dispatch_id: decision.dispatch_id,
      task_fingerprint: decision.state_fingerprint,
      outcome,
      details,
    });
  const lease = new TaskLease(
    path.join(options.stateDirectory, 'leases', `${task.id}.lock`),
    options.leaseTtlMs ?? 30_000,
  );
  const acquired = await lease.acquire(decision, runId);
  if (acquired === 'contended') {
    const contentionDirectory = path.join(options.stateDirectory, 'contention');
    await fs.mkdir(contentionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(contentionDirectory, `${task.id}-${runId}.json`),
      `${JSON.stringify({
        schema_version: RUNNER_SCHEMA_VERSION,
        type: 'lease_contention',
        task_id: task.id,
        run_id: runId,
        outcome: 'LEASE_CONTENDED',
      })}\n`,
      { flag: 'wx' },
    );
    return { run_id: runId, outcome: 'LEASE_CONTENDED', decision };
  }
  await append(acquired === 'recovered' ? 'lease_recovery' : 'lease_acquire', acquired);
  try {
    if (options.stopFile && (await exists(options.stopFile))) {
      await append('stop', 'STOPPED');
      return { run_id: runId, outcome: 'STOPPED', decision };
    }
    if (task.state === 'COMPLETED') {
      await append('decision', 'NO_ACTION_TERMINAL');
      return { run_id: runId, outcome: 'NO_ACTION_TERMINAL', decision };
    }
    const facts = await reconcileRunnerFacts(options.companyRoot, task, options.githubResolver);
    decision = decideRunnerAction(task, facts);
    await lease.bind(runId, decision);
    await append('lease_identity', 'BOUND');
    const previous = await ledger.read();
    const unresolvedIntent = previous.some(
      (event) =>
        event.dispatch_id === decision.dispatch_id &&
        ['dispatch_intent', 'dispatch_start'].includes(event.type) &&
        !previous.some(
          (result) =>
            result.dispatch_id === decision.dispatch_id && result.type === 'dispatch_result',
        ),
    );
    if (unresolvedIntent) {
      await append('recovery', 'RECOVERY_REQUIRED', { blocker: 'ambiguous prior launch' });
      return { run_id: runId, outcome: 'RECOVERY_REQUIRED', decision };
    }
    if (
      previous.some(
        (event) => event.dispatch_id === decision.dispatch_id && event.type === 'dispatch_result',
      )
    ) {
      await append('decision', 'NO_ACTION_UNCHANGED');
      return { run_id: runId, outcome: 'NO_ACTION_UNCHANGED', decision };
    }
    const failureCount = previous.filter(
      (event) => event.type === 'failure' || event.type === 'circuit_break',
    ).length;
    if (failureCount >= (options.circuitFailureThreshold ?? 3)) {
      await append('circuit_break', 'OPEN', { failure_count: failureCount });
      return { run_id: runId, outcome: 'FAILED', decision };
    }
    const refreshedTask = await readRunnerTask(options.companyRoot, options.taskId);
    const refreshedFacts = await reconcileRunnerFacts(
      options.companyRoot,
      refreshedTask,
      options.githubResolver,
    );
    const refreshed = decideRunnerAction(refreshedTask, refreshedFacts);
    if (refreshed.dispatch_id !== decision.dispatch_id) {
      await append('failure', 'STALE_STATE');
      return { run_id: runId, outcome: 'FAILED', decision };
    }
    if (decision.classification !== 'GREEN') {
      const approval = approvalPackage(
        decision,
        runId,
        facts.evidence.map((item) => item.path),
      );
      if (!options.approvalSchemaPath)
        throw new Error('An explicit checked-in approval schema path is required.');
      await validateApprovalPackageSchema(approval, options.approvalSchemaPath);
      await fs.mkdir(path.join(options.stateDirectory, 'approvals'), { recursive: true });
      await fs.writeFile(
        path.join(
          options.stateDirectory,
          'approvals',
          `${approval.request_id.replace(':', '-')}.json`,
        ),
        `${JSON.stringify(approval, null, 2)}\n`,
        { flag: 'wx' },
      );
      await append('approval_request', 'APPROVAL_REQUIRED', {
        classification: decision.classification,
        requested_action: decision.action_kind,
      });
      return { run_id: runId, outcome: 'APPROVAL_REQUIRED', decision, approval };
    }
    if (options.dryRun) {
      await append('decision', 'DRY_RUN', { classification: decision.classification });
      return { run_id: runId, outcome: 'DRY_RUN', decision };
    }
    await append('dispatch_intent', 'PERSISTED');
    const controller = new AbortController();
    const externalAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    let heartbeatFailure: Error | undefined;
    let heartbeatWork = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatWork = heartbeatWork.then(async () => {
        try {
          await lease.renew(runId);
          await append('lease_heartbeat', 'RENEWED');
        } catch (error) {
          heartbeatFailure = error as Error;
          controller.abort();
        }
      });
    }, options.heartbeatMs ?? 10_000);
    const stopMonitor = options.stopFile
      ? setInterval(
          () => {
            void exists(options.stopFile!).then((stopped) => stopped && controller.abort());
          },
          Math.min(options.heartbeatMs ?? 10_000, 1_000),
        )
      : undefined;
    await append('dispatch_start', 'STARTED');
    let dispatch: DispatchResult;
    try {
      const packet: HandoffPacket = {
        schema_version: RUNNER_SCHEMA_VERSION,
        task: { id: task.id, path: task.path, fingerprint: decision.state_fingerprint },
        role: task.owner,
        state: task.state,
        dispatch_id: decision.dispatch_id,
        evidence: facts.evidence.map((item) => item.path),
        instruction:
          'Load the authoritative task and execute only the exact next role-owned governed action. Save evidence before any legal handoff.',
      };
      try {
        dispatch = await options.dispatcher.dispatch(packet, controller.signal);
      } catch (error) {
        if (!(error instanceof TransientPrelaunchError)) throw error;
        await append('retry', 'TRANSIENT_PRELAUNCH', { attempt: 1 });
        dispatch = await options.dispatcher.dispatch(packet, controller.signal);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (stopMonitor) clearInterval(stopMonitor);
      options.signal?.removeEventListener('abort', externalAbort);
    }
    await heartbeatWork;
    if (heartbeatFailure) throw heartbeatFailure;
    // Timers are advisory under event-loop load: dispatch may settle before the
    // first interval callback runs.  Persist and verify one final heartbeat so
    // success can never be reported after lease persistence or ownership loss.
    await lease.renew(runId);
    await append('lease_heartbeat', 'RENEWED', { checkpoint: 'post_dispatch' });
    const postTask = await readRunnerTask(options.companyRoot, options.taskId);
    let postOutcome = 'UNCHANGED';
    if (postTask.bytes !== task.bytes) {
      if (!isLegalRunnerTransition(task, postTask))
        throw new Error(`Agent produced illegal transition ${task.state} -> ${postTask.state}.`);
      const postFacts = await reconcileRunnerFacts(
        options.companyRoot,
        postTask,
        options.githubResolver,
      );
      await verifyObservedTransition(options.companyRoot, task, postTask, postFacts);
      postOutcome = 'OBSERVED_TRANSITION';
      await append('observed_transition', postOutcome, {
        from: task.state,
        to: postTask.state,
        owner: postTask.owner,
      });
    }
    await append(
      'dispatch_result',
      dispatch.exitCode === 0 && !dispatch.timedOut ? postOutcome : 'FAILED',
      {
        exit_code: dispatch.exitCode,
        timed_out: dispatch.timedOut,
        model: dispatch.model,
        input_tokens: dispatch.inputTokens,
        output_tokens: dispatch.outputTokens,
      },
    );
    return { run_id: runId, outcome: 'DISPATCHED', decision, dispatch };
  } catch (error) {
    await append('failure', 'FAILED', {
      blocker: error instanceof Error ? error.message : 'unknown runner failure',
    }).catch(() => undefined);
    throw error;
  } finally {
    await append('lease_release', 'RELEASED');
    await lease.release(runId);
  }
}

export interface RunLoopOptions extends RunOnceOptions {
  maxDispatches?: number;
  idleTimeoutMs?: number;
  waitForEvent?: (signal: AbortSignal) => Promise<void>;
}

export interface RunLoopResult {
  results: RunOnceResult[];
  stop_reason: 'RUN_ONCE' | 'MAX_DISPATCHES' | 'IDLE_TIMEOUT' | 'OUTCOME_STOP';
}

/** Event mode is opt-in. It never polls for work and is capped at four launches per process. */
export async function runCompany(options: RunLoopOptions): Promise<RunLoopResult> {
  const maximum = options.maxDispatches ?? 1;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4)
    throw new Error('Runner dispatch maximum must be an integer from one through four.');
  const results: RunOnceResult[] = [];
  let dispatches = 0;
  while (dispatches < maximum) {
    const result = await runCompanyOnce(options);
    results.push(result);
    if (result.outcome === 'DISPATCHED') dispatches++;
    if (maximum === 1) return { results, stop_reason: 'RUN_ONCE' };
    if (result.outcome !== 'DISPATCHED') return { results, stop_reason: 'OUTCOME_STOP' };
    if (dispatches >= maximum) return { results, stop_reason: 'MAX_DISPATCHES' };
    if (!options.waitForEvent)
      throw new Error('Event mode requires an explicit deterministic event source.');
    const controller = new AbortController();
    let timedOut = false;
    let resolveIdle!: () => void;
    const idlePromise = new Promise<void>((resolve) => (resolveIdle = resolve));
    const idle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolveIdle();
    }, options.idleTimeoutMs ?? 30_000);
    try {
      await Promise.race([options.waitForEvent(controller.signal), idlePromise]);
      if (timedOut) return { results, stop_reason: 'IDLE_TIMEOUT' };
    } catch (error) {
      if (timedOut) return { results, stop_reason: 'IDLE_TIMEOUT' };
      throw error;
    } finally {
      clearTimeout(idle);
    }
  }
  return { results, stop_reason: 'MAX_DISPATCHES' };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function runnerStatus(
  companyRoot: string,
  taskId: string,
  stateDirectory: string,
): Promise<Record<string, unknown>> {
  const task = await readRunnerTask(companyRoot, taskId);
  const events = await new RunnerLedger(path.join(stateDirectory, `${taskId}.jsonl`)).read();
  const last = events.at(-1);
  const lastDispatch = [...events].reverse().find((event) => event.type === 'dispatch_result');
  const lastTransition = [...events]
    .reverse()
    .find((event) => event.type === 'observed_transition');
  const lastSuccess = [...events]
    .reverse()
    .find(
      (event) =>
        ['observed_transition', 'dispatch_result'].includes(event.type) &&
        event.outcome !== 'FAILED',
    );
  const lastBlocker = [...events]
    .reverse()
    .find((event) => ['failure', 'recovery', 'circuit_break'].includes(event.type));
  const approval = [...events].reverse().find((event) => event.type === 'approval_request');
  const leaseFile = path.join(stateDirectory, 'leases', `${taskId}.lock`);
  let lease: Lease | null = null;
  if (await exists(leaseFile)) lease = JSON.parse(await fs.readFile(leaseFile, 'utf8')) as Lease;
  return {
    schema_version: RUNNER_SCHEMA_VERSION,
    task: task.id,
    state: task.state,
    owner: task.owner,
    last_action: last?.type ?? null,
    last_outcome: last?.outcome ?? null,
    last_transition: lastTransition?.details ?? null,
    last_successful_action: lastSuccess?.type ?? null,
    pending_approval: approval
      ? { classification: approval.details.classification, dispatch_id: approval.dispatch_id }
      : null,
    blocker: lastBlocker ? { outcome: lastBlocker.outcome, details: lastBlocker.details } : null,
    lease: lease
      ? {
          status: 'held',
          run_id: lease.run_id,
          heartbeat_at: lease.heartbeat_at,
          expires_at: lease.expires_at,
        }
      : { status: 'free' },
    dispatch_count: events.filter((event) => event.type === 'dispatch_start').length,
    retry_count: events.filter((event) => event.type === 'retry').length,
    circuit: [...events].reverse().find((event) => event.type === 'circuit_break')
      ? 'open'
      : 'closed',
    model: (lastDispatch?.details.model as string | undefined) ?? 'unknown',
    input_tokens: (lastDispatch?.details.input_tokens as number | undefined) ?? 'unknown',
    output_tokens: (lastDispatch?.details.output_tokens as number | undefined) ?? 'unknown',
  };
}

