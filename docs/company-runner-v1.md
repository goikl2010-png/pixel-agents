# Company Runner V1 operator contract

Company Runner V1 is a single-task, run-once control plane. The company Markdown task remains authoritative; the local ledger is orchestration evidence only. It never chooses QA/review outcomes, performs handoffs, merges, closes Issues/PRs, or marks work complete.

Use `runCompanyOnce` with an explicit `TASK-###`, company root, task-local state directory, and dispatcher. `dryRun: true` computes the same fingerprint and dispatch identity while making no agent or GitHub call and changing no authoritative file. Production dispatch requires the constrained `CodexAgentDispatcher`; deterministic tests and rehearsals use `FakeAgentDispatcher`.

The production adapter probes the Codex global and `exec` help surfaces separately. For Codex CLI 0.149, the managed human-approval policy is a global option, so the direct argument array starts with `--ask-for-approval`, `on-request`, `exec`. `--approve-for-me` has different automatic-review semantics and is never substituted or allowed.

The default is one dispatch. RED/UNKNOWN, `APPROVED`, unresolved `BLOCKED`, terminal/unchanged state, lease contention, stop file, integrity failure, and ambiguous launch recovery stop without a new model invocation. The module has no daemon installation, multi-task queue, external advisor/API, or workflow-mutation adapter.

## Governed GitHub launch environment

The operator must configure exactly one supported source name (`GH_TOKEN` or `GITHUB_TOKEN`) on the constrained Codex dispatcher. The trusted parent environment must contain exactly one non-empty, case-unambiguous value for that selected name and no value for the other supported name. Missing, empty, duplicate-case, conflicting, malformed, or ambiguous input fails before version probing or agent launch.

The value is passed only in the direct child-process environment. It is never accepted from CLI arguments, tasks, evidence, prompts, URLs, files, or configuration values, and is never serialized, hashed, logged, audited, returned, persisted, or included in status, approval packages, errors, or captured output. The child environment is constructed from a small operational OS allowlist instead of inheriting the parent secret environment.

Git HTTPS uses process-scoped `http.sslBackend=openssl` by composition with inherited `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, and `GIT_CONFIG_VALUE_n` entries. Existing entries are preserved; malformed entries and a conflicting TLS backend fail closed. TLS verification remains enabled. The Runner never writes system, global, repository, or worktree Git configuration.

State output and pending approval packages are local, versioned JSON. Treat the state directory as append-only evidence. Deleting or editing ledger records makes deduplication unsafe and fails closed.

