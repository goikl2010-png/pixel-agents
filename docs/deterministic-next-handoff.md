# Deterministic next-handoff selection

The selector consumes exactly one actionable-task discovery result and reports a next transition only when TASK-009 authorizes that source state and TASK-007's canonical planner confirms exactly one safe legal non-`BLOCKED`, nonterminal successor.

```text
pixel-agents --discover-task Nova --company-tasks-root C:\AI-Company --select-next-handoff
```

A selection exits `0`. Refusals, malformed inputs, and `none`, `conflict`, or `error` discovery outcomes exit `1`. JSON output always includes the task identity, source state/owner/storage, nullable target state/owner/storage, `selected`, and a stable reason code/message. Identical discovery input produces byte-equivalent JSON.

Automatic selection is limited to `BACKLOG` → `DEVELOPMENT`, `DEVELOPMENT` → `READY_FOR_QA`, `CHANGES_REQUIRED` → `QA_RETEST`, and `READY_FOR_REVIEW` → `REVIEW`. The selector refuses `READY_FOR_QA`, `QA`, `QA_RETEST`, and `REVIEW` because acceptance, evidence, or judgment remains role-owned. It refuses `APPROVED` and `BLOCKED` because Alex authority is required, and refuses terminal `COMPLETED`.

Selection is read-only and is not authorization or evidence. It does not plan an explicit caller-requested target, invoke the guarded executor, edit or move records, create evidence, communicate a handoff, choose QA/review outcomes, block or unblock work, mutate GitHub, merge, close, or archive anything. Callers must separately satisfy company gates and explicitly use TASK-007 planning and TASK-008 execution where authorized.
