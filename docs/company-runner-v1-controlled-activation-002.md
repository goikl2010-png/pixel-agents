# Company Runner V1 post-TASK-028 activation package

Schema v3 is the successor activation package for the existing protected TASK-020 proof target after TASK-028 legitimately completed without a Runner dispatch. It does not modify or reinterpret schema v1, the historical TASK-028 schema-v2 contract, TASK-020 bytes, or any historical lifecycle evidence.

`config/company-runner-v1-activation-002.template.json` is deliberately invalid until its three placeholders are replaced with the freshly verified TASK-020 record SHA-256, current PR #4 head, and exact TASK-030 Runner head covered by Pixel and Atlas. The finalized governance-owned artifact is `C:\AI-Company\config\company-runner-v1-activation-002.json`. Its canonical SHA-256 is computed from UTF-8 `JSON.stringify(validatedConfiguration, null, 2) + "\n"` bytes and must match the separate Goi RED authorization exactly.

The only supported target is TASK-020 at `READY_FOR_QA / Pixel`, Issue #3, PR #4, branch `task/TASK-020-reconcile-company-runner-roadmap`, and the exact three protected documentation paths already enforced by the production launcher. Draft state, task bytes, PR head, and file statistics are accepted only when fresh GitHub facts exactly match the authorization.

The configuration remains `active: false`, `mode: run-once`, maximum one dispatch, 120000 ms timeout, exact `codex-cli 0.152.1`, `workspace-write`, `on-request`, and `workflow_mutation_adapter: false`. The shared governance gate runs first. Any HOLD, terminal or wrong task state, stale path/hash/head, authorization/configuration/checkout mismatch, authentication or capability failure, dirty checkout, stop/lease/recovery ambiguity, or unexpected PR scope fails closed before dispatch.

TASK-030 preparation and closure do not authorize checkout movement, HOLD release, Runner activation or dispatch, credentials/configuration changes, deployment, or TASK-020 mutation. Those remain a separate exact Goi RED boundary after a fresh read-only activation preflight.
