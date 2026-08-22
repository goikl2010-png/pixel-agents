import * as os from 'os';

const TEST_HOME_KEYS = ['HOME', 'USERPROFILE'] as const;

export function isolateTestHome(testHome: string): () => void {
  const originalEnvironment = Object.fromEntries(
    TEST_HOME_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof TEST_HOME_KEYS)[number], string | undefined>;

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;

  if (os.homedir() !== testHome) {
    restoreEnvironment(originalEnvironment);
    throw new Error(`Failed to isolate the test home: os.homedir() did not resolve to ${testHome}`);
  }

  return () => restoreEnvironment(originalEnvironment);
}

function restoreEnvironment(
  originalEnvironment: Record<(typeof TEST_HOME_KEYS)[number], string | undefined>,
): void {
  for (const key of TEST_HOME_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
