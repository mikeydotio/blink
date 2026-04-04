# Task Management with Storyhook

This project uses **storyhook** (`story` CLI) for work tracking.

**Important:** The `.storyhook/` directory is version-controlled project data. Do NOT add it to `.gitignore`.

## Session lifecycle

1. Run `story load-context` at the start of every session to understand project state.
2. Run `story next` to find the highest-priority ready task.
3. Update story status as you work: `story move BL-<n> in-progress`
4. Add progress notes: `story comment BL-<n> "what changed and why"`
5. Mark complete: `story move BL-<n> done "summary of what was delivered"`
6. Run `story handoff --since 2h` at end of session.

## Planning mode

When creating implementation plans, create a story for each discrete work item, phase, or issue:

```
story new "Phase 1: Set up database schema"
story new "Phase 2: Implement API endpoints"
story new "Phase 3: Add authentication middleware"
```

Define relationships between stories to express dependencies and structure:

```
story relate BL-1 parent-of BL-2
story relate BL-2 blocks BL-3
story relate BL-5 relates-to BL-2
story relate BL-6 obviates BL-7
```

Set priority on each story so `story next` surfaces the right work:

```
story prioritize BL-1 critical
story prioritize BL-4 high
story prioritize BL-6 medium
```

## During execution

- Before starting a story: `story move BL-<n> in-progress`
- When blocked: `story block BL-<n> "reason"`
- When unblocked: `story unblock BL-<n>`
- When done: `story move BL-<n> done "what was delivered"`
- To check what's ready: `story next --count 5`
- To see blocked work: `story list --blocked`
- To see the dependency graph: `story graph`

## Commands

| Action | Command |
|---|---|
| Project overview | `story load-context` |
| Next ready task | `story next` |
| List open stories | `story list` |
| Show a story | `story show BL-<n>` |
| Create a story | `story new "<title>"` |
| Add a comment | `story comment BL-<n> "comment text"` |
| Move to state | `story move BL-<n> <state>` |
| Set priority | `story prioritize BL-<n> high` |
| Assign a story | `story assign BL-<n> <member>` |
| Add a label | `story label BL-<n> <label>` |
| Set multiple fields | `story set BL-<n> --priority high --state in-progress` |
| Add relationship | `story relate BL-1 blocks BL-2` |
| Search | `story search "<query>"` |
| Summary stats | `story summary` |
| Dependency graph | `story graph` |
| Interactive TUI | `story tui` |
| Session handoff | `story handoff --since 2h` |
