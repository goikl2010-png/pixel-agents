# Read-only handoff transition planner

The handoff planner validates one explicitly requested lifecycle transition for the single task returned by actionable-task discovery. It reports a plan only: it does not authorize or perform a handoff, edit or move task records, create GitHub artifacts, send messages, launch sessions, or choose a branching outcome.

Run discovery and planning through the existing standalone CLI:

```text
pixel-agents --discover-task Nova --company-tasks-root C:\AI-Company --plan-handoff READY_FOR_QA
```

The target is case-sensitive and must be explicit. Legal plans exit `0`; illegal plans, discovery conflicts/errors, and malformed inputs exit `1`. Output is JSON with the task ID and source path/storage, source state/owner, requested target state, target owner, legal flag, deterministic reason, and destination storage.

Entering `BLOCKED` requires all five metadata arguments:

```text
--blocked-reporter Nova --blocked-blocker "reason" \
--blocked-resolution "required action" --blocked-evidence "evidence reference" \
--blocked-resume-state DEVELOPMENT
```

The resume state must exactly equal the current source state. Resuming a discovered `BLOCKED` task requires the exact saved Resume state as `--plan-handoff` plus `--alex-authorized-resume`. This flag records planner input only; Alex's authorization evidence and the saved company handoff remain external requirements.

Destination mapping follows company governance: `BACKLOG` uses `backlog`; `DEVELOPMENT` and `CHANGES_REQUIRED` use `active`; QA, retest, review, and approval states use `review`; `COMPLETED` uses `completed`; and `BLOCKED` retains the discovered task's current authoritative storage class. Planning never changes that storage.

The lifecycle table is centralized in `handoffTransitionPlanner.ts` and is verified against `AGENTS.md` by the complete legal/illegal transition matrix tests. The planner consumes TASK-006's typed `found` result directly and never reparses or independently selects a task. `none`, `conflict`, and `error` discovery results fail closed.
