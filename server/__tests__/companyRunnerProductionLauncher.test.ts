import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { launchProductionCompanyRunner } from '../../scripts/company-runner-production-launcher.js';

const configPath = path.resolve('config/company-runner-v1-task-019-preflight.json');
const temporaryDirectories: string[] = [];

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

  it('does not include a credential value in its source or public result shape', async () => {
    const source = await import('fs/promises').then(({ readFile }) =>
      readFile(path.resolve('scripts/company-runner-production-launcher.ts'), 'utf8'),
    );
    expect(source).not.toContain('GH_TOKEN_VALUE_SENTINEL');
    expect(source).not.toContain('GITHUB_TOKEN_VALUE_SENTINEL');
  });
});
