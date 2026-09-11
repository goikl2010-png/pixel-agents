# Company Runner V1 TASK-035 activation package

Schema v5 is the additive successor activation contract for TASK-035. It leaves schemas v1-v4 and their historical targets unchanged. The only supported initial target is TASK-035 at `READY_FOR_QA / Pixel`, Issue #18, OPEN non-draft PR #19, branch `task/TASK-035-runner-v1-activation-canary-004`, and exactly `documentation/runner-v1-activation-canary-004.md` (one commit, eight additions, zero deletions).

`config/company-runner-v1-activation-004.template.json` is deliberately invalid until its three placeholders are replaced by the exact published TASK-035 task-record SHA-256, current PR #19 head, and TASK-036 Runner head covered by Pixel and Atlas. The finalized governance-owned artifact is `C:\AI-Company\config\company-runner-v1-activation-004.json`; its canonical SHA-256 is computed from UTF-8 `JSON.stringify(validatedConfiguration, null, 2) + "\n"` bytes and must exactly match a separate Goi RED authorization.

The package remains inactive with `active: false`, `mode: run-once`, one dispatch maximum, a 120000 ms timeout, 30000 ms lease, 10000 ms heartbeat, circuit threshold 3, exact `codex-cli 0.154.0`, `workspace-write`, `on-request`, and `workflow_mutation_adapter: false`. The shared governance gate runs before authorization parsing or any launch. Any HOLD, target, task bytes, GitHub scope, authorization, package, checkout, credential, exact-version, capability, lease, STOP, circuit, or recovery drift fails closed before dispatch.

TASK-036 delivery authorizes no RED artifact, credentials, checkout movement, HOLD release, Runner activation, or dispatch. Those remain separate owner-controlled actions after Pixel and Atlas cover the exact final Runner head and Alex completes TASK-036.
