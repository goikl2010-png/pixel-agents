# Codex provider (Phase 1)

Pixel Agents can receive supported Codex lifecycle hooks at `/api/hooks/codex` alongside the existing Claude endpoint. Hook payloads are authenticated with the same per-server bearer token and sessions are keyed as `codex:<session_id>`, preventing collisions with Claude IDs.

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

Run `npm run check-types`, `npm run test:server`, and `npm run build`. With a trusted Codex hook configuration and Pixel Agents running, start a Codex session in a tracked workspace and verify start, prompt/tool activity, stop/waiting, and eventual end behavior.
