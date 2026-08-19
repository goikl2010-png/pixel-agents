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
  allowedExecutable: string;
  timeoutMs: number;
  credentialEnvironmentVariable: 'GH_TOKEN' | 'GITHUB_TOKEN';
  parentEnvironment?: NodeJS.ProcessEnv;
  versionProbe?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<string>;
  spawnProcess?: typeof spawnDirect;
}

const FORBIDDEN_ARGUMENT =
  /(^|\s)(--dangerously-bypass|--full-auto|--sandbox\s+danger-full-access|--config|--ask-for-approval\s+never)($|\s)/i;

export class CodexAgentDispatcher implements AgentDispatcher {
  constructor(private readonly options: CodexDispatcherOptions) {}

  async dispatch(packet: HandoffPacket, signal: AbortSignal): Promise<DispatchResult> {
    const executable = path.resolve(this.options.executable);
    if (executable !== path.resolve(this.options.allowedExecutable))
      throw new Error('Configured Codex executable is not allowlisted.');
    const root = path.resolve(this.options.workingRoot);
    if (!path.isAbsolute(root)) throw new Error('Codex working root must be absolute.');
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
    const prompt = JSON.stringify(packet);
    const args = [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--cd',
      root,
      prompt,
    ];
    if (args.some((argument) => FORBIDDEN_ARGUMENT.test(argument)))
      throw new Error('Codex invocation contains a forbidden permission or bypass argument.');
    return (this.options.spawnProcess ?? spawnDirect)(
      executable,
      args,
      root,
      this.options.timeoutMs,
      signal,
      childEnvironment,
    );
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

async function spawnDirect(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, signal });
    let settled = false;
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        exitCode: null,
        timedOut: true,
        model: 'unknown',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        launched: true,
      });
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code) =>
      finish({
        exitCode: code,
        timedOut: false,
        model: 'unknown',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        launched: true,
      }),
    );
  });
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
  const evidence = [...match.bytes.matchAll(/`((?:documentation|tasks)[^`]+)`/g)]
    .map((item) => item[1])
    .sort();
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

export function decideRunnerAction(task: RunnerTask, githubFacts = ''): RunnerDecision {
  const fingerprint = sha256(
    `${task.path.replace(/\\/g, '/')}\n${task.bytes}\n${task.evidence.join('\n')}\n${githubFacts}`,
  );
  let action: RunnerDecision['action_kind'] = 'DISPATCH_ROLE';
  let classification: ApprovalClass = 'GREEN';
  let reason = `Dispatch the role that owns ${task.state}; the role remains responsible for evidence and transition decisions.`;
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
  risk_approval_class: 'RED' | 'UNKNOWN';
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
  if (decision.classification !== 'RED' && decision.classification !== 'UNKNOWN')
    throw new Error('Approval package requires RED or UNKNOWN classification.');
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
    affected_files_resources: [decision.task_path],
    branch_pr: { repository: 'unknown', branch: 'unknown', pr: null, head: 'unknown' },
    external_effects: [],
    risk_approval_class: decision.classification,
    recommended_next_action:
      'Alex/Goi decision and fresh evidence required; do not dispatch automatically.',
    evidence,
    run_id: runId,
    dispatch_id: decision.dispatch_id,
  };
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
  githubFacts?: string;
  stopFile?: string;
  timeoutMs?: number;
}
export interface RunOnceResult {
  run_id: string;
  outcome: RunnerOutcome;
  decision: RunnerDecision;
  dispatch?: DispatchResult;
  approval?: ApprovalPackage;
}

export async function runCompanyOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const runId = randomUUID();
  const task = await readRunnerTask(options.companyRoot, options.taskId);
  const decision = decideRunnerAction(task, options.githubFacts);
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
  const previous = await ledger.read();
  if (
    previous.some(
      (event) =>
        event.dispatch_id === decision.dispatch_id &&
        ['dispatch_intent', 'dispatch_start'].includes(event.type) &&
        !previous.some(
          (result) =>
            result.dispatch_id === decision.dispatch_id && result.type === 'dispatch_result',
        ),
    )
  ) {
    await append('recovery', 'RECOVERY_REQUIRED');
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
  if (options.stopFile && (await exists(options.stopFile))) {
    await append('stop', 'STOPPED');
    return { run_id: runId, outcome: 'STOPPED', decision };
  }
  if (decision.action_kind === 'STOP_TERMINAL') {
    await append('decision', 'NO_ACTION_TERMINAL');
    return { run_id: runId, outcome: 'NO_ACTION_TERMINAL', decision };
  }
  if (decision.classification === 'RED' || decision.classification === 'UNKNOWN') {
    const approval = approvalPackage(decision, runId, task.evidence);
    await fs.mkdir(path.join(options.stateDirectory, 'approvals'), { recursive: true });
    await fs.writeFile(
      path.join(
        options.stateDirectory,
        'approvals',
        `${approval.request_id.replace(':', '-')}.json`,
      ),
      `${JSON.stringify(approval, null, 2)}\n`,
    );
    await append('approval_request', 'APPROVAL_REQUIRED', {
      classification: decision.classification,
    });
    return { run_id: runId, outcome: 'APPROVAL_REQUIRED', decision, approval };
  }
  if (options.dryRun) {
    await append('decision', 'DRY_RUN');
    return { run_id: runId, outcome: 'DRY_RUN', decision };
  }
  const lease = new TaskLease(path.join(options.stateDirectory, 'leases', `${task.id}.lock`));
  const acquired = await lease.acquire(decision, runId);
  if (acquired === 'contended') {
    await append('lease_contention', 'LEASE_CONTENDED');
    return { run_id: runId, outcome: 'LEASE_CONTENDED', decision };
  }
  await append(acquired === 'recovered' ? 'lease_recovery' : 'lease_acquire', acquired);
  try {
    const refreshed = decideRunnerAction(
      await readRunnerTask(options.companyRoot, options.taskId),
      options.githubFacts,
    );
    if (refreshed.dispatch_id !== decision.dispatch_id) {
      await append('failure', 'STALE_STATE');
      return { run_id: runId, outcome: 'FAILED', decision };
    }
    await append('dispatch_intent', 'PERSISTED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    await append('dispatch_start', 'STARTED');
    let dispatch: DispatchResult;
    try {
      dispatch = await options.dispatcher.dispatch(
        {
          schema_version: RUNNER_SCHEMA_VERSION,
          task: { id: task.id, path: task.path, fingerprint: decision.state_fingerprint },
          role: task.owner,
          state: task.state,
          dispatch_id: decision.dispatch_id,
          evidence: task.evidence,
          instruction:
            'Load the authoritative task and execute only the exact next role-owned governed action. Save evidence before any legal handoff.',
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
    await append(
      'dispatch_result',
      dispatch.exitCode === 0 && !dispatch.timedOut ? 'OBSERVATION_REQUIRED' : 'FAILED',
      {
        exit_code: dispatch.exitCode,
        timed_out: dispatch.timedOut,
        model: dispatch.model,
        input_tokens: dispatch.inputTokens,
        output_tokens: dispatch.outputTokens,
      },
    );
    return { run_id: runId, outcome: 'DISPATCHED', decision, dispatch };
  } finally {
    await lease.release(runId);
    await append('lease_release', 'RELEASED');
  }
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
  return {
    schema_version: RUNNER_SCHEMA_VERSION,
    task: task.id,
    state: task.state,
    owner: task.owner,
    last_action: last?.type ?? null,
    last_outcome: last?.outcome ?? null,
    pending_approval: last?.type === 'approval_request',
    lease: (await exists(path.join(stateDirectory, 'leases', `${taskId}.lock`))) ? 'held' : 'free',
    dispatch_count: events.filter((event) => event.type === 'dispatch_start').length,
    retry_count: 0,
    circuit: events.some((event) => event.type === 'circuit_break') ? 'open' : 'closed',
    model: (lastDispatch?.details.model as string | undefined) ?? 'unknown',
    input_tokens: (lastDispatch?.details.input_tokens as number | undefined) ?? 'unknown',
    output_tokens: (lastDispatch?.details.output_tokens as number | undefined) ?? 'unknown',
  };
}
