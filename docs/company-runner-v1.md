# Company Runner V1 operator contract

Company Runner V1 is a single-task, run-once control plane. The company Markdown task remains authoritative; the local ledger is orchestration evidence only. It never chooses QA/review outcomes, performs handoffs, merges, closes Issues/PRs, or marks work complete.

Use `runCompanyOnce` with an explicit `TASK-###`, company root, task-local state directory, and dispatcher. `dryRun: true` computes the same fingerprint and dispatch identity while making no agent or GitHub call and changing no authoritative file. Production dispatch requires the constrained `CodexAgentDispatcher`; deterministic tests and rehearsals use `FakeAgentDispatcher`.

The production adapter probes the Codex global and `exec` help surfaces separately. The global probe must contain exactly one canonical `--ask-for-approval <APPROVAL_POLICY>` declaration and exactly one advertised `on-request` value; missing, malformed, unsupported, or duplicate/ambiguous evidence fails closed before launch. For Codex CLI 0.149, the managed human-approval policy is a global option, so the direct argument array starts with `--ask-for-approval`, `on-request`, `exec`. `--approve-for-me` has different automatic-review semantics and is never substituted or allowed.

The default is one dispatch. RED/UNKNOWN, `APPROVED`, unresolved `BLOCKED`, terminal/unchanged state, lease contention, stop file, integrity failure, and ambiguous launch recovery stop without a new model invocation. The module has no daemon installation, multi-task queue, external advisor/API, or workflow-mutation adapter.

## Governed GitHub launch environment

The operator must provide exactly one canonical source name (`GH_TOKEN`) to the constrained Codex dispatcher. `GITHUB_TOKEN`, enterprise variants, duplicate-case names, empty values, and any conflicting source are rejected. Missing, empty, malformed, or ambiguous input fails before GitHub preflight, version probing, or agent launch.

Before any child launch, the Runner performs a value-blind `gh api user` identity check and an exact `gh api repos/<approved-repository>` scope check. Only non-secret response fields are validated; the credential value is never inspected, printed, serialized, hashed, logged, persisted, or returned.

The value is passed only in the direct child-process environment. It is never accepted from CLI arguments, tasks, evidence, prompts, URLs, files, or configuration values, and is never serialized, hashed, logged, audited, returned, persisted, or included in status, approval packages, errors, or captured output. The child environment is constructed from a small operational OS allowlist instead of inheriting the parent secret environment.

Git HTTPS uses process-scoped `http.sslBackend=openssl` by composition with inherited `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, and `GIT_CONFIG_VALUE_n` entries. Existing entries are preserved; malformed entries and a conflicting TLS backend fail closed. TLS verification remains enabled. The Runner never writes system, global, repository, or worktree Git configuration.

State output and pending approval packages are local, versioned JSON. Treat the state directory as append-only evidence. Deleting or editing ledger records makes deduplication unsafe and fails closed.

