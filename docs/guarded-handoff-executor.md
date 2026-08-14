# Guarded handoff executor

The guarded executor performs exactly one explicitly requested, legal, nonterminal task handoff. It composes the existing TASK-006 discovery and TASK-007 planner contracts; it does not select an outcome, authorize an actor, create evidence, communicate a handoff, or replace any company gate.

The caller must first obtain the exact SHA-256 hash of the authoritative source Markdown and supply every execution field:

```text
pixel-agents --discover-task Nova --company-tasks-root C:\AI-Company \
  --plan-handoff READY_FOR_QA --execute-handoff \
  --expected-source-hash <lowercase-sha256> \
  --handoff-actor Nova --handoff-recipient Pixel \
  --handoff-timestamp "2026-08-14 14:00 +08:00" \
  --handoff-evidence "commit, PR, and verification references" \
  --handoff-next-action "independently test the exact PR head"
```

Success exits `0`; refusal or failure exits `1`. JSON output reports task, transition, owners, source/destination paths, before/after hashes, success, and a deterministic reason. Evidence fields must be nonblank single-line values without Markdown table delimiters. Actor and recipient must exactly match the planned source and target owners.

Immediately before writing, execution repeats actionable-task discovery and regenerates the transition plan. It then atomically claims the source by renaming it to a non-Markdown backup and reads, hashes, and derives the update only from that claimed file object. A concurrent edit made before the claim is therefore included in the claimed bytes and causes an expected-hash refusal; it cannot be silently replaced by output derived from an earlier read.

After validating the claimed hash, the transaction writes updated content to a non-Markdown temporary file and uses an exclusive hard-link create to install the planned destination without overwriting a path created by a contender. For cross-directory transitions, it checks that the old source path has not been recreated before installation, after installation, during cleanup, and before success. Source recreation is a deterministic failure: an executor-installed destination is removed, the contender is preserved byte-for-byte, and only transaction-owned temporary/backup files are discarded. A mismatch, collision, write/install failure, or transient rollback failure likewise preserves at least one current authoritative record and cleans transaction artifacts. The mutation is limited to `Previous state`, `Current state`, `Owner`, the non-BLOCKED `Resume state`, and one appended Handoff History row; other content and task files remain byte-identical. Source and destination must share a filesystem that supports hard links; unsupported or cross-filesystem installation fails closed.

TASK-008 refuses `BLOCKED` entry/resume, any transition involving `COMPLETED`, and `APPROVED` to `COMPLETED`. Blocking, unblocking, QA/review decisions, approval, merge, closure, Issue/PR changes, employee messaging, and session launch remain external role-owned actions. The executor has no GitHub, network, messaging, or session capability.
