# TASK-019 exact inactive live-pilot preflight

This package is evidence only. It keeps Company Runner inactive and does not authorize or perform a dispatch. The sole contemplated target is TASK-020 at authoritative `READY_FOR_QA / Pixel`, path `C:\AI-Company\tasks\review\codex-pixel-agents-020.md`, SHA-256 `a4686195f2a37822beea0b789879d044d063a01b4d6fe952128503aabf983279`.

Live target facts recorded on 2026-08-23 are AI-Company Issue #3 OPEN and PR #4 OPEN, DRAFT, CLEAN/MERGEABLE, base `main` at `3012789263188bc041bbb12192b6d08539c9b3dd`, head `task/TASK-020-reconcile-company-runner-roadmap` at `5b5357d3f6359d3df94ed5fe8371750fa34b25e3`, one commit, and exactly `COMPANY-MEMORY.md`, `memory/project-history.md`, and `projects/codex-pixel-agents-integration/PROJECT.md` (83 additions, zero deletions). TASK-020 is safe only because Pixel is its governed owner and QA acceptance is the next legal role-owned action; Runner may dispatch Pixel but may not accept QA, test, select an outcome, or mutate lifecycle state.

## Fixed inactive configuration

The reviewed source is `config/company-runner-v1-task-019-preflight.json`. It fixes one task, `run-once`, maximum one dispatch, production `codex` dispatcher, `on-request`, approved root `C:\AI-Company`, isolated state `C:\AI-Company\.company-runner-state\TASK-019`, operator stop file, 120-second timeout, 30-second lease, 10-second heartbeat, three-failure circuit, and disabled TASK-011 workflow mutation. It contains only the credential variable name `GH_TOKEN`, never a credential value.

Exact SHA-256 evidence after canonical formatting is: configuration `91c84a842b6978fccbe4e2c0a05aace8ac78317c04a7251b22138930da48ce07`; Codex output schema `924a838b574ed7088f009d0ff6be1774db09a5bcf28e99025e8cd10701ccd97b`; approval schema `5999b5fcf7ccdc7a8498fc197e55a0275775eda5931fd4c30a9ff5229fad1efa`; and lockfile `b9776bd087bcc9bc389ceefa79bfb732a459438264a5433d0e35e4c0ded49a6e`. The target-task hash is recorded above. Any mismatch fails closed and requires a newly reviewed package.

Runner baseline is live `pixel-agents/main` merge `eb7f613e3c0da315f055dff09b7e5c221f79cf0b`. The allowlisted executable is `C:\Users\X1 CARBON\AppData\Roaming\npm\codex.cmd`, version `codex-cli 0.150.1`. Read-only probes must show exactly one canonical global `--ask-for-approval <APPROVAL_POLICY>` declaration with advertised `on-request`; `exec` must expose `--json`, `--output-schema <FILE>`, `--cd <DIR>`, and `--sandbox <SANDBOX_MODE>`. The supported global-before-`exec` form must succeed and the obsolete post-`exec` form must fail without launch.

The direct argument template is exactly `--ask-for-approval`, `on-request`, `exec`, `--json`, `--sandbox`, `workspace-write`, `--cd`, `C:\AI-Company`, `--output-schema`, the reviewed schema path, and the JSON handoff packet. `--approve-for-me`, `never`, bypass, full-auto, danger-full-access, config override, and shell execution are prohibited.

## Expected effects and non-effects

If separately authorized later, one bounded Codex child may read the selected TASK-020 evidence and perform only Pixel's role-owned QA work. It may write only isolated Runner audit/status state and Pixel-authorized QA evidence permitted by the then-current exact authorization. It must not mutate TASK-020 lifecycle state automatically, edit product implementation, merge, close, complete, deploy, enable TASK-011, modify credentials/configuration, persist a credential, activate a service, or dispatch twice.

No effect is authorized by this package. Development, QA, and review use read-only probes, config/schema validation, CLI dry-run with isolated state, and disposable fake/shadow fixtures only. Baseline hashes of the authoritative task, configuration, Runner commit, schemas, and lockfile must be checked again immediately before any proposed live dispatch.

## Stop, rollback, and evidence

Stop on any task/path/hash/PR/head/base/scope/state/owner drift; missing or ambiguous credential variable; executable/version/capability/schema/argument mismatch; dirty checkout; lease contention; heartbeat loss; timeout; signal or stop file; open circuit; recovery ambiguity; approval requirement; unexpected effect; or lifecycle-mutation request. Missing, stale, or conflicting evidence fails closed.

Timeout is 120 seconds. Alex owns rollback and the isolated state directory. Rollback terminates the bounded child, preserves audit/status/approval and ambiguity evidence, leaves authoritative task and GitHub facts unchanged, and revokes only an exposed ephemeral credential if necessary. Post-run reconciliation must record result, exact hashes, audit/status chain, dispatch/retry count, token/model accounting, lease/circuit/recovery state, external effects, stop/rollback actions, and redacted secret-scan outcome.

A live dispatch requires fresh written Goi authorization naming the then-current target fingerprint, Runner commit, configuration hash, executable/capabilities, argument array, credential boundary, expected effects, rollback, timeout, and stop conditions. Approval of this Pull Request is not dispatch authorization.
