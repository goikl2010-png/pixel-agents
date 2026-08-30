# Company Runner V1 operator contract

Company Runner V1 is a single-task, run-once control plane. The company Markdown task remains authoritative; the local ledger is orchestration evidence only. It never chooses QA/review outcomes, performs handoffs, merges, closes Issues/PRs, or marks work complete.

Use `runCompanyOnce` with an explicit `TASK-###`, company root, task-local state directory, and dispatcher. `dryRun: true` computes the same fingerprint and dispatch identity while making no agent or GitHub call and changing no authoritative file. Production dispatch requires the constrained `CodexAgentDispatcher`; deterministic tests and rehearsals use `FakeAgentDispatcher`.

The production adapter probes the Codex global and `exec` help surfaces separately. The global probe must contain exactly one canonical `--ask-for-approval <APPROVAL_POLICY>` declaration and exactly one advertised `on-request` value; missing, malformed, unsupported, or duplicate/ambiguous evidence fails closed before launch. For the pinned Codex CLI 0.150.1, the managed human-approval policy is a global option, so the direct argument array starts with `--ask-for-approval`, `on-request`, `exec`. `--approve-for-me` has different automatic-review semantics and is never substituted or allowed.

The default is one dispatch. RED/UNKNOWN, `APPROVED`, unresolved `BLOCKED`, terminal/unchanged state, lease contention, stop file, integrity failure, and ambiguous launch recovery stop without a new model invocation. The module has no daemon installation, multi-task queue, external advisor/API, or workflow-mutation adapter.

## State-authorized TASK-020 activation sequence

The checked-in inactive TASK-019 configuration fixes the TASK-020 identity, initial `READY_FOR_QA / Pixel` bytes, executable, sandbox, argument array, state directory, and process bounds. It does not pre-authorize a later lifecycle state. Every production invocation requires a new exact Goi RED authorization built from the freshly read task bytes and current GitHub facts.

The only accepted state/owner pairs are Pixel at `READY_FOR_QA`, `QA`, or `QA_RETEST`; Atlas at `READY_FOR_REVIEW` or `REVIEW`; and Alex at `APPROVED`. The Alex pair is an owner-only RED stop: Runner writes and returns the exact approval package and launches no agent. `CHANGES_REQUIRED`, `BLOCKED`, `COMPLETED`, wrong-role pairs, and every other pair fail before launch. Nova corrections at `CHANGES_REQUIRED` remain outside production Runner dispatch and return through the repository lifecycle to a freshly authorized `QA_RETEST / Pixel` invocation.

The authorization pins the current task SHA-256, state, owner, PR draft value, base, branch, head, commit/addition/deletion counts, and exact changed-file facts. Live GitHub facts must equal the authorization. The allowed TASK-020 PR paths remain exactly `COMPANY-MEMORY.md`, `memory/project-history.md`, and `projects/codex-pixel-agents-integration/PROJECT.md`; omission, extra scope, malformed statistics, or drift fails closed. The initial `READY_FOR_QA / Pixel` authorization must also match the protected configuration task hash and head. Later state hashes and a corrected PR head may differ only when a new authorization names them exactly and all other configured boundaries remain exact.

At `READY_FOR_QA` only, one unique inline `Implementation Evidence` section may satisfy the evidence gate without a fabricated path. It must contain every delivery field, bind to the authoritative branch, PR number, and current head commit, and contain no pending required value. Missing, duplicate, conflicting, incomplete, or stale inline evidence is rejected. All later QA, correction, retest, and review states continue to require their linked role-owned evidence, including one current-head `PASSED` QA record before Atlas or Alex states.

No invocation chains into another state or pre-authorizes a successor. A changed task byte, evidence record, PR fact, Runner commit, configuration, executable/capability, credential boundary, checkout, stop/lease/circuit/recovery fact, or dispatch history changes the governed identity and requires a fresh authorization. The one-dispatch maximum and duplicate/recovery protections remain unchanged.

## Governed GitHub launch environment

The operator must provide exactly one canonical source name (`GH_TOKEN`) to the constrained Codex dispatcher. `GITHUB_TOKEN`, enterprise variants, duplicate-case names, empty values, and any conflicting source are rejected. Missing, empty, malformed, or ambiguous input fails before GitHub preflight, version probing, or agent launch.

Before any child launch, the Runner resolves an explicit approved GitHub login (the configured login, or the exact owner of the approved repository), performs a value-blind `gh api user` identity check against that login, and performs an exact `gh api repos/<approved-repository>` scope check. GitHub logins are compared case-insensitively. Only non-secret response fields are validated; the credential value is never inspected, printed, serialized, hashed, logged, persisted, or returned.

The value is passed only in the direct child-process environment. It is never accepted from CLI arguments, tasks, evidence, prompts, URLs, files, or configuration values, and is never serialized, hashed, logged, audited, returned, persisted, or included in status, approval packages, errors, or captured output. The child environment is constructed from a small operational OS allowlist instead of inheriting the parent secret environment.

Git HTTPS uses process-scoped `http.sslBackend=openssl` by composition with inherited `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, and `GIT_CONFIG_VALUE_n` entries. Existing entries are preserved; malformed entries and a conflicting TLS backend fail closed. TLS verification remains enabled. The Runner never writes system, global, repository, or worktree Git configuration.

State output and pending approval packages are local, versioned JSON. Treat the state directory as append-only evidence. Deleting or editing ledger records makes deduplication unsafe and fails closed.
