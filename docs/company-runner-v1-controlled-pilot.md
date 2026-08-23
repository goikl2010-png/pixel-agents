# Company Runner V1 controlled-pilot runbook

This runbook prepares evidence; it does not authorize or activate Company Runner. The example is deliberately inactive, uses the deterministic fake dispatcher, names one task, permits one dispatch, and keeps the TASK-011 workflow-mutation adapter disabled. It names an ephemeral credential environment variable but never contains a credential.

## Safe shadow rehearsal

1. Use a clean checkout of the reviewed pilot commit. Record `git status --short`, `git rev-parse HEAD`, and the selected disposable fixture hash.
2. Copy `config/company-runner-v1.example.json` outside the repository. Replace `TASK-XXX` with one disposable fixture ID and path placeholders with absolute disposable paths. Do not change `active`, `mode`, `max_dispatches`, `dispatcher`, `approval_policy`, hard bounds, or `workflow_mutation_adapter`.
3. Use fake GitHub facts and non-secret evidence. Never point the harness at `C:\AI-Company`, a live worktree, `main`, TASK-011, TASK-012, TASK-013, or a completed task.
4. Run `npx vitest run server/__tests__/companyRunnerPilot.test.ts`. The harness copies the fixture to an OS temporary directory, uses only `FakeAgentDispatcher`, deletes the copy, and proves the source hash is unchanged.
5. Retain the commit/configuration/fixture hashes, decision, fingerprint, dispatch ID, handoff, approval class, proposed action, status, audit outcome, dispatch/retry count, model/token accounting, lease/circuit/recovery state, and test output. Confirm no credential value appears.

Existing CLI dry-run is also non-activating, but writes audit evidence only to the supplied isolated state directory:

```text
node dist/cli.js --runner-task TASK-XXX --company-tasks-root <disposable-fixture-root> --runner-state-directory <disposable-state-root> --runner-dry-run
```

Do not use `--runner-fake` against authoritative company files; use the shadow harness.

## Failure, recovery, and stop controls

- Create the stop file or send `SIGINT`/`SIGTERM` to abort. Do not restart until status proves the lease is free and no ambiguous launch remains.
- A live lease is never stolen. Only an expired lease owned by a proven-dead local process is recoverable. Ambiguous crash evidence returns `RECOVERY_REQUIRED` with zero redispatch.
- One transient prelaunch failure receives at most one retry. Three persisted failures open the circuit. Timeout is capped at 120 seconds; graceful termination is followed by bounded forced termination.
- Preserve ledger, approval, and contention evidence. Tampering, malformed facts/configuration/output, heartbeat loss, credential ambiguity, protected/pending decisions, and kill-switch activation fail closed.
- Runner observes a role-owned transition only after unique current-head evidence and the authoritative update. It never selects QA/review outcomes, resolves BLOCKED, enables TASK-011, merges, closes, completes, or changes lifecycle state itself.

## Separately authorized live pilot

This section is a checklist, not authorization. Stop unless Goi provides fresh written authorization naming one non-protected task and the exact reviewed commit/configuration. It must state the exact Codex executable/version/capabilities, approved root, argument array, selected ephemeral auth variable, expected effects, rollback owner, timeout, stop conditions, and explicitly authorize one live dispatch.

Before that dispatch record clean checkout and hashes for `main`, task, evidence, configuration, executable, schemas, and lockfile; OPEN Issue/PR and exact head; matching task state/owner/current-head evidence; exact allowlisted executable and separate global/`exec` probes; absolute root; output schema; `workspace-write`; global `--ask-for-approval on-request` before `exec`; free lease; closed circuit; no recovery ambiguity/pending approval; isolated state; stop file; timeout; and rollback location. `--approve-for-me` is not equivalent and is prohibited.

Supply exactly one non-empty, case-unambiguous `GH_TOKEN` only in the child environment. Reject `GITHUB_TOKEN`, unrelated secrets, and ambiguous sources. Compose process-scoped OpenSSL Git configuration without collision, keep TLS verification enabled, and write no global/repository configuration. Run the value-blind identity and exact approved-repository preflight before launch.

Stop on hash/fact drift, protected scope, missing evidence, credential ambiguity, schema/capability mismatch, lease contention, heartbeat loss, timeout, signal/kill switch, open circuit, approval requirement, recovery ambiguity, unexpected effect, or lifecycle mutation request. Rollback terminates the bounded child, preserves audit/status, revokes only an exposed ephemeral credential if needed, and leaves authoritative task/GitHub/configuration untouched for Alex.

Afterward capture result, audit/status chain, retry and token/model accounting, lease/circuit/recovery, hashes, external effects, stop/rollback actions, and secret-scan result. Success does not authorize another dispatch, service, scheduler, watcher, deployment, TASK-011 integration, merge, closure, or activation.

