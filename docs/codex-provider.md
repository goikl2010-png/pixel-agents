# Codex provider (Phase 1)

Pixel Agents can receive supported Codex lifecycle hooks at `/api/hooks/codex` alongside the existing Claude endpoint. Hook payloads are authenticated with the same per-server bearer token and sessions are keyed as `codex:<session_id>`, preventing collisions with Claude IDs.

## Employee identity contract

Set `PIXEL_AGENTS_EMPLOYEE_IDENTITY` in the environment of the Codex process to exactly one canonical value: `Alex`, `Nova`, `Pixel`, or `Atlas`. The installed hook copies that value into the authenticated hook payload as `pixel_agents_employee_identity`; the Codex provider validates it and displays it through the existing character-name surface. This metadata is descriptive only and is not an authentication or authorization credential.

PowerShell examples:

```powershell
$env:PIXEL_AGENTS_EMPLOYEE_IDENTITY='Alex'; codex
$env:PIXEL_AGENTS_EMPLOYEE_IDENTITY='Nova'; codex
$env:PIXEL_AGENTS_EMPLOYEE_IDENTITY='Pixel'; codex
$env:PIXEL_AGENTS_EMPLOYEE_IDENTITY='Atlas'; codex
```

POSIX shell examples:

```sh
PIXEL_AGENTS_EMPLOYEE_IDENTITY=Alex codex
PIXEL_AGENTS_EMPLOYEE_IDENTITY=Nova codex
PIXEL_AGENTS_EMPLOYEE_IDENTITY=Pixel codex
PIXEL_AGENTS_EMPLOYEE_IDENTITY=Atlas codex
```

Identity is bound when a new `codex:<session_id>` is adopted and remains unchanged for that live session. Ending or removing the session deletes the character and its association; a new session ID starts with only its own metadata. Multiple concurrent sessions may intentionally use the same employee value: each remains a distinct character routed by its own provider-qualified session ID, and each displays the same declared label.

The contract is exact and case-sensitive. Missing, empty, non-string, altered-case, unknown, or markup-shaped values fall back to the existing generic Codex character without failing hook delivery or affecting another session. Environment inheritance is the only automatic propagation: launchers that strip environment variables must explicitly preserve this variable. Identity does not infer employee identity from prompts, directories, transcripts, or other content.

## Read-only actionable-task discovery

The standalone CLI can combine that same canonical identity with authoritative AI Company task records:

```powershell
npx pixel-agents --discover-task Nova --company-tasks-root C:\AI-Company
```

The configurable root must contain `tasks/backlog`, `tasks/active`, and `tasks/review`. The resolver reads Markdown fields rather than inferring state from directory placement. It validates the lifecycle mapping: Alex owns `BACKLOG`, `APPROVED`, and `BLOCKED`; Nova owns `DEVELOPMENT` and `CHANGES_REQUIRED`; Pixel owns `READY_FOR_QA`, `QA`, and `QA_RETEST`; Atlas owns `READY_FOR_REVIEW` and `REVIEW`. `COMPLETED` is non-actionable, and `BLOCKED` must be owned by Alex with a valid nonterminal Resume state.

The command prints deterministic JSON with outcome `found`, `none`, `conflict`, or `error`. Conflicts and malformed or contradictory records produce a nonzero exit code and are never guessed through. Discovery only reads files: it does not edit tasks, advance lifecycle states, contact GitHub, send handoffs, start sessions, or weaken QA, review, approval, merge, and closure gates.

Developer verification:

```sh
npx vitest run server/__tests__/actionableTaskDiscovery.test.ts server/__tests__/cli.test.ts
npm run check-types
```

## Setup and trust

Starting Pixel Agents installs entries for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, and `SessionEnd` in `~/.codex/hooks.json` and copies a best-effort forwarder to `~/.pixel-agents/hooks/codex-hook.js`. Existing hooks and unrelated configuration are preserved. Install and uninstall are idempotent and use an atomic replacement write.

Codex requires the normal user review/trust flow for non-managed hooks. Pixel Agents does not bypass or weaken that boundary; review and trust the installed definitions in Codex before expecting events.

## Lifecycle mapping

- `SessionStart` creates one hooks-only character for the stable Codex session ID.
- `UserPromptSubmit` and `PreToolUse` mark it active; `PostToolUse` ends the matching tool activity.
- `PermissionRequest` shows the permission state.
- `Stop` marks the session waiting for input without removing it.
- `SessionEnd` removes the external session character.

Codex transcripts remain optional diagnostics and are not parsed as a Phase 1 contract. Hosted tools may not emit tool hooks. `SessionEnd` can be delayed until close/archive/delete or approximately 30 minutes after an idle conversation, so disappearance is not guaranteed to be immediate. Forwarding is best-effort and never blocks Codex when Pixel Agents is unavailable.

## Local verification

Run `npm run check-types`, `npm run test:server`, and `npm run build`. With a trusted Codex hook configuration and Pixel Agents running, launch sessions using the examples above and verify all four labels, independent activity, duplicate-label independence, generic fallback with the variable unset or invalid, and eventual removal. Confirm a Claude session with the same raw session ID remains isolated.
