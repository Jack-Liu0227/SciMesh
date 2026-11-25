# Research workspace

A workspace for the user's research goal. The primary agent can work directly
or coordinate available specialists, then check their evidence and synthesize
the result. Every role follows the same workspace and approval bounds.

## Work cycle

After each work cycle, review the result and save reusable lessons into memory.
The primary agent maintains shared knowledge and rules and makes local git
checkpoints. The independent reviewer remains a separate read-only role.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Identity, mission, collaboration, approval bounds, principles, and self-review. |
| `KNOWLEDGE.md` | Knowledge index. |
| `knowledge/` | Current facts: `system.md` covers the system model, and `current-state.md` covers goals and progress. |
| `notes/` | Daily logs appended by date. Old entries are not edited after their day ends. |

## Startup Order

1. Read `AGENTS.md`.
2. Read `KNOWLEDGE.md`.
3. Read the latest 2-3 files in `notes/`.
4. Check the goal, worktree, code, data, and logs.

## Memory Rules

- `knowledge/` stores current facts only; update it when facts change.
- `notes/` stores daily logs; append during the day and do not edit old entries.
- Principle changes go directly into `AGENTS.md`.
