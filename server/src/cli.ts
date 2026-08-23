#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as path from 'path';

import { launchProductionCompanyRunner } from '../../scripts/company-runner-production-launcher.js';
import {
  discoverActionableTask,
  EMPLOYEE_IDENTITIES,
  type EmployeeIdentity,
} from './actionableTaskDiscovery.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import {
  FakeAgentDispatcher,
  GhCliGitHubFactResolver,
  runCompanyOnce,
  runnerStatus,
} from './companyRunner.js';
import { readConfig } from './configPersistence.js';
import { MAX_PORT, MIN_PORT } from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { executeHandoff } from './handoffExecutor.js';
import { planHandoffTransition } from './handoffTransitionPlanner.js';
import { selectNextHandoff } from './nextHandoffSelector.js';
import {
  claudeProvider,
  codexProvider,
  copyCodexHookScript,
  copyHookScript,
} from './providers/index.js';
import { PixelAgentsServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  discoverTask?: EmployeeIdentity;
  companyTasksRoot?: string;
  planHandoff?: string;
  selectNextHandoff?: boolean;
  blockedReporter?: EmployeeIdentity;
  blockedBlocker?: string;
  blockedResolution?: string;
  blockedEvidence?: string;
  blockedResumeState?: string;
  alexAuthorizedResume?: boolean;
  executeHandoff?: boolean;
  expectedSourceHash?: string;
  handoffActor?: EmployeeIdentity;
  handoffRecipient?: EmployeeIdentity;
  handoffTimestamp?: string;
  handoffEvidence?: string;
  handoffNextAction?: string;
  runnerTask?: string;
  runnerStateDirectory?: string;
  runnerDryRun?: boolean;
  runnerStatus?: boolean;
  runnerFake?: boolean;
  runnerProductionLaunch?: boolean;
  runnerPreflightConfig?: string;
  runnerAuthorization?: string;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--discover-task') {
      const identity = argv[i + 1];
      if (!EMPLOYEE_IDENTITIES.includes(identity as EmployeeIdentity)) {
        throw new CliArgsError(
          `Invalid --discover-task identity ${JSON.stringify(identity)}: expected Alex, Nova, Pixel, or Atlas.`,
        );
      }
      args.discoverTask = identity as EmployeeIdentity;
      i++;
    } else if (argv[i] === '--company-tasks-root' && argv[i + 1]) {
      args.companyTasksRoot = argv[i + 1];
      i++;
    } else if (argv[i] === '--plan-handoff') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --plan-handoff.');
      args.planHandoff = argv[++i];
    } else if (argv[i] === '--select-next-handoff') {
      args.selectNextHandoff = true;
    } else if (argv[i] === '--blocked-reporter') {
      const identity = argv[i + 1];
      if (!identity) throw new CliArgsError('Missing value for --blocked-reporter.');
      if (!EMPLOYEE_IDENTITIES.includes(identity as EmployeeIdentity))
        throw new CliArgsError(`Invalid --blocked-reporter identity ${JSON.stringify(identity)}.`);
      args.blockedReporter = identity as EmployeeIdentity;
      i++;
    } else if (argv[i] === '--blocked-blocker') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --blocked-blocker.');
      args.blockedBlocker = argv[++i];
    } else if (argv[i] === '--blocked-resolution') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --blocked-resolution.');
      args.blockedResolution = argv[++i];
    } else if (argv[i] === '--blocked-evidence') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --blocked-evidence.');
      args.blockedEvidence = argv[++i];
    } else if (argv[i] === '--blocked-resume-state') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --blocked-resume-state.');
      args.blockedResumeState = argv[++i];
    } else if (argv[i] === '--alex-authorized-resume') {
      args.alexAuthorizedResume = true;
    } else if (argv[i] === '--execute-handoff') {
      args.executeHandoff = true;
    } else if (argv[i] === '--expected-source-hash') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --expected-source-hash.');
      args.expectedSourceHash = argv[++i];
    } else if (argv[i] === '--handoff-actor' || argv[i] === '--handoff-recipient') {
      const option = argv[i];
      const identity = argv[i + 1];
      if (!identity) throw new CliArgsError(`Missing value for ${option}.`);
      if (!EMPLOYEE_IDENTITIES.includes(identity as EmployeeIdentity))
        throw new CliArgsError(`Invalid ${option} identity ${JSON.stringify(identity)}.`);
      if (option === '--handoff-actor') args.handoffActor = identity as EmployeeIdentity;
      else args.handoffRecipient = identity as EmployeeIdentity;
      i++;
    } else if (argv[i] === '--handoff-timestamp') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --handoff-timestamp.');
      args.handoffTimestamp = argv[++i];
    } else if (argv[i] === '--handoff-evidence') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --handoff-evidence.');
      args.handoffEvidence = argv[++i];
    } else if (argv[i] === '--handoff-next-action') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --handoff-next-action.');
      args.handoffNextAction = argv[++i];
    } else if (argv[i] === '--runner-task') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --runner-task.');
      args.runnerTask = argv[++i];
    } else if (argv[i] === '--runner-state-directory') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --runner-state-directory.');
      args.runnerStateDirectory = argv[++i];
    } else if (argv[i] === '--runner-dry-run') {
      args.runnerDryRun = true;
    } else if (argv[i] === '--runner-status') {
      args.runnerStatus = true;
    } else if (argv[i] === '--runner-fake') {
      args.runnerFake = true;
    } else if (argv[i] === '--runner-production-launch') {
      args.runnerProductionLaunch = true;
    } else if (argv[i] === '--runner-preflight-config') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --runner-preflight-config.');
      args.runnerPreflightConfig = argv[++i];
    } else if (argv[i] === '--runner-authorization') {
      if (!argv[i + 1]) throw new CliArgsError('Missing value for --runner-authorization.');
      args.runnerAuthorization = argv[++i];
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --discover-task <id>  Report the employee's authoritative actionable task
  --company-tasks-root  Root containing the authoritative tasks directories
  --plan-handoff <state> Plan one explicit transition for the discovered task
  --select-next-handoff Select one uniquely safe next transition (read-only)
  --blocked-reporter <id> --blocked-blocker <text> --blocked-resolution <text>
  --blocked-evidence <text> --blocked-resume-state <state>
                         Required metadata when planning entry to BLOCKED
  --alex-authorized-resume
                         Confirm Alex authorized an exact BLOCKED resume
  --execute-handoff      Execute the legal nonterminal plan exactly once
  --expected-source-hash <sha256>
  --handoff-actor <id> --handoff-recipient <id> --handoff-timestamp <text>
  --handoff-evidence <text> --handoff-next-action <text>
                         Required caller-supplied guarded execution inputs
  --runner-task <TASK-ID> Run Company Runner V1 once for one explicit task
  --runner-state-directory <path>
                         Isolated append-only Runner evidence directory
  --runner-dry-run       Compute decision without agent/task/GitHub mutation
  --runner-status        Print machine-readable Runner status without dispatch
  --runner-fake          Use deterministic fake adapter (test/rehearsal only)
  --runner-production-launch
                         Run the exact authorized TASK-019 production entry point once
  --runner-preflight-config <path>
                         Canonical TASK-019 preflight package
  --runner-authorization <path>
                         Exact fresh Goi RED authorization artifact
  --help                Show this help message`);
      process.exit(0);
    }
  }

  return args;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (args.planHandoff && !args.discoverTask) {
    console.error('[Pixel Agents] --plan-handoff requires --discover-task.');
    process.exitCode = 1;
    return;
  }
  if (args.selectNextHandoff && !args.discoverTask) {
    console.error('[Pixel Agents] --select-next-handoff requires --discover-task.');
    process.exitCode = 1;
    return;
  }
  if (args.selectNextHandoff && args.planHandoff) {
    console.error('[Pixel Agents] --select-next-handoff cannot be combined with --plan-handoff.');
    process.exitCode = 1;
    return;
  }
  if (args.executeHandoff && !args.planHandoff) {
    console.error('[Pixel Agents] --execute-handoff requires --plan-handoff.');
    process.exitCode = 1;
    return;
  }
  const hasPlannerOnlyInput =
    args.blockedReporter !== undefined ||
    args.blockedBlocker !== undefined ||
    args.blockedResolution !== undefined ||
    args.blockedEvidence !== undefined ||
    args.blockedResumeState !== undefined ||
    args.alexAuthorizedResume !== undefined;
  if (hasPlannerOnlyInput && !args.planHandoff) {
    console.error('[Pixel Agents] BLOCKED planner inputs require --plan-handoff.');
    process.exitCode = 1;
    return;
  }
  const hasExecutionOnlyInput =
    args.expectedSourceHash !== undefined ||
    args.handoffActor !== undefined ||
    args.handoffRecipient !== undefined ||
    args.handoffTimestamp !== undefined ||
    args.handoffEvidence !== undefined ||
    args.handoffNextAction !== undefined;
  if (hasExecutionOnlyInput && !args.executeHandoff) {
    console.error('[Pixel Agents] guarded execution inputs require --execute-handoff.');
    process.exitCode = 1;
    return;
  }

  if (args.runnerTask) {
    if (!args.companyTasksRoot || !args.runnerStateDirectory) {
      console.error(
        '[Pixel Agents] --runner-task requires --company-tasks-root and --runner-state-directory.',
      );
      process.exitCode = 1;
      return;
    }
    if (!args.runnerStatus && !args.runnerDryRun && !args.runnerFake) {
      console.error(
        '[Pixel Agents] live Runner dispatch requires an explicitly configured adapter; use --runner-dry-run or --runner-fake for safe operation.',
      );
      process.exitCode = 1;
      return;
    }
    const result = args.runnerStatus
      ? await runnerStatus(args.companyTasksRoot, args.runnerTask, args.runnerStateDirectory)
      : await runCompanyOnce({
          companyRoot: args.companyTasksRoot,
          taskId: args.runnerTask,
          stateDirectory: args.runnerStateDirectory,
          dispatcher: new FakeAgentDispatcher(),
          dryRun: args.runnerDryRun,
          githubResolver: new GhCliGitHubFactResolver({
            credentialEnvironmentVariable: 'GH_TOKEN',
          }),
          approvalSchemaPath: path.resolve(
            __dirname,
            '..',
            'docs',
            'schemas',
            'company-runner-approval-v1.schema.json',
          ),
        });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.runnerProductionLaunch) {
    if (!args.runnerPreflightConfig || !args.runnerAuthorization || !args.companyTasksRoot) {
      console.error(
        '[Pixel Agents] production launch requires --company-tasks-root, --runner-preflight-config, and --runner-authorization.',
      );
      process.exitCode = 1;
      return;
    }
    try {
      const result = await launchProductionCompanyRunner({
        companyRoot: args.companyTasksRoot,
        configPath: args.runnerPreflightConfig,
        authorizationPath: args.runnerAuthorization,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        `[Pixel Agents] ${error instanceof Error ? error.message : 'Production launch failed closed.'}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (args.discoverTask) {
    if (!args.companyTasksRoot) {
      console.error('[Pixel Agents] --discover-task requires --company-tasks-root.');
      process.exitCode = 1;
      return;
    }
    const tasksRoot = path.resolve(args.companyTasksRoot, 'tasks');
    const locations = {
      backlog: path.join(tasksRoot, 'backlog'),
      active: path.join(tasksRoot, 'active'),
      review: path.join(tasksRoot, 'review'),
    };
    const result = await discoverActionableTask(args.discoverTask, locations);
    if (args.selectNextHandoff) {
      const selection = selectNextHandoff(result);
      console.log(JSON.stringify(selection, null, 2));
      process.exitCode = selection.selected ? 0 : 1;
    } else if (args.planHandoff) {
      const blockedValues = [
        args.blockedReporter,
        args.blockedBlocker,
        args.blockedResolution,
        args.blockedEvidence,
        args.blockedResumeState,
      ];
      const hasAnyBlockedValue = blockedValues.some((value) => value !== undefined);
      const hasAllBlockedValues = blockedValues.every((value) => value !== undefined);
      const plan = planHandoffTransition({
        discovery: result,
        requestedTargetState: args.planHandoff,
        ...(hasAllBlockedValues
          ? {
              blockedEntry: {
                reporter: args.blockedReporter!,
                blocker: args.blockedBlocker!,
                resolution: args.blockedResolution!,
                evidence: args.blockedEvidence!,
                resumeState: args.blockedResumeState!,
              },
            }
          : {}),
        ...(args.alexAuthorizedResume ? { alexAuthorizedResume: true } : {}),
      });
      if (hasAnyBlockedValue && !hasAllBlockedValues) {
        plan.legal = false;
        plan.reason = 'Blocked-entry CLI metadata is incomplete.';
      }
      if (args.executeHandoff) {
        const executionValues = [
          args.expectedSourceHash,
          args.handoffActor,
          args.handoffRecipient,
          args.handoffTimestamp,
          args.handoffEvidence,
          args.handoffNextAction,
        ];
        if (executionValues.some((value) => value === undefined)) {
          console.log(
            JSON.stringify(
              {
                taskId: result.outcome === 'found' ? result.task.taskId : null,
                sourceState: plan.sourceState,
                targetState: plan.requestedTargetState,
                sourceOwner: plan.sourceOwner,
                targetOwner: plan.targetOwner,
                sourcePath: plan.sourcePath,
                destinationPath: null,
                beforeHash: null,
                afterHash: null,
                success: false,
                reason: 'Guarded execution inputs are incomplete.',
              },
              null,
              2,
            ),
          );
          process.exitCode = 1;
        } else {
          const execution = await executeHandoff({
            discovery: result,
            plan,
            locations,
            expectedSourceHash: args.expectedSourceHash!,
            handoff: {
              actor: args.handoffActor!,
              recipient: args.handoffRecipient!,
              timestamp: args.handoffTimestamp!,
              evidence: args.handoffEvidence!,
              nextAction: args.handoffNextAction!,
            },
          });
          console.log(JSON.stringify(execution, null, 2));
          process.exitCode = execution.success ? 0 : 1;
        }
      } else {
        console.log(JSON.stringify(plan, null, 2));
        process.exitCode = plan.legal ? 0 : 1;
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.outcome === 'found' || result.outcome === 'none' ? 0 : 1;
    }
    return;
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider);

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall hooks when user toggles in UI.
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        await codexProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        const copied = copyHookScript(packageRoot);
        const codexCopied = copyCodexHookScript(packageRoot);
        console.log(
          copied && codexCopied
            ? '[Pixel Agents] Hooks installed (user toggle)'
            : '[Pixel Agents] Hooks NOT installed (user toggle), hook script missing',
        );
      } else {
        await claudeProvider.uninstallHooks();
        await codexProvider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Pixel Agents] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick
    runtime.hooksEnabled.current = adapter.getSetting('pixel-agents.hooksEnabled', true);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        await codexProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        const copied = copyHookScript(packageRoot);
        const codexCopied = copyCodexHookScript(packageRoot);
        console.log(
          copied && codexCopied
            ? '[Pixel Agents] Hooks installed'
            : '[Pixel Agents] Hooks NOT installed, hook script missing',
        );
      } catch (err) {
        console.error('[Pixel Agents] Failed to install hooks:', err);
      }
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    console.log(`\n  Pixel Agents server running at http://${args.host}:${config.port}\n`);

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
