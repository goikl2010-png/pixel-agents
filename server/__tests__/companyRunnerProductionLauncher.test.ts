import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { launchProductionCompanyRunner } from '../../scripts/company-runner-production-launcher.js';
import { task019ConfigurationSha256 } from '../../scripts/company-runner-task-019-preflight.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(repositoryRoot, 'config/company-runner-v1-task-019-preflight.json');
const temporaryDirectories: string[] = [];

async function writeAuthorization(directory: string, targetSha256: string): Promise<string> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const authorizationPath = path.join(directory, 'authorization.json');
  await writeFile(
    authorizationPath,
    JSON.stringify({
      schema_version: '1',
      authorization: 'RED',
      authorized_by: 'Goi',
      task_id: 'TASK-020',
      target_state: 'READY_FOR_QA',
      target_owner: 'Pixel',
      target_sha256: targetSha256,
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
      configuration_sha256: task019ConfigurationSha256(config),
      runner_commit: config.runner_commit,
      executable: config.executable,
      codex_version: config.codex_version,
      approved_working_root: config.approved_working_root,
      output_schema: config.output_schema,
      argument_template: config.argument_template,
      credential_environment_variable: 'GH_TOKEN',
      max_dispatches: 1,
      expected_effects: [],
      rollback: 'stop',
      timeout_ms: config.timeout_ms,
      stop_conditions: [],
    }),
  );
  return authorizationPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('production Company Runner launcher', () => {
  it('fails closed before any dispatcher or GitHub seam on malformed authorization', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'task-022-launcher-'));
    temporaryDirectories.push(directory);
    const authorizationPath = path.join(directory, 'authorization.json');
    await writeFile(authorizationPath, '{"schema_version":"1"}\n');
    let githubCalls = 0;
    let dispatchCalls = 0;

    await expect(
      launchProductionCompanyRunner({
        configPath,
        authorizationPath,
        companyRoot: 'C:\\AI-Company',
        githubRun: async () => {
          githubCalls++;
          return {};
        },
        dispatcher: {
          dispatch: async () => {
            dispatchCalls++;
            throw new Error('must not dispatch');
          },
        },
      }),
    ).rejects.toThrow('exact RED contract');
    expect(githubCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('accepts the canonical target fingerprint during exact authorization', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'task-022-launcher-'));
    temporaryDirectories.push(directory);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { target_sha256: string };
    const authorizationPath = await writeAuthorization(directory, config.target_sha256);

    await expect(
      launchProductionCompanyRunner({
        configPath,
        authorizationPath,
        companyRoot: 'C:\\AI-Company-not-authorized',
      }),
    ).rejects.toThrow('root drifted');
  });

  it('rejects a validly shaped mismatched target fingerprint before any seam', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'task-022-launcher-'));
    temporaryDirectories.push(directory);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { target_sha256: string };
    const authorizationPath = await writeAuthorization(
      directory,
      `${config.target_sha256.slice(0, -1)}${config.target_sha256.endsWith('0') ? '1' : '0'}`,
    );
    let githubCalls = 0;
    let dispatchCalls = 0;

    await expect(
      launchProductionCompanyRunner({
        configPath,
        authorizationPath,
        companyRoot: 'C:\\AI-Company',
        githubRun: async () => {
          githubCalls++;
          return {};
        },
        dispatcher: {
          dispatch: async () => {
            dispatchCalls++;
            throw new Error('must not dispatch');
          },
        },
      }),
    ).rejects.toThrow('target fingerprint drifted');
    expect(githubCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });

  it('does not include a credential value in its source or public result shape', async () => {
    const source = await import('fs/promises').then(({ readFile }) =>
      readFile(path.join(repositoryRoot, 'scripts/company-runner-production-launcher.ts'), 'utf8'),
    );
    expect(source).not.toContain('GH_TOKEN_VALUE_SENTINEL');
    expect(source).not.toContain('GITHUB_TOKEN_VALUE_SENTINEL');
  });
});
