# NEXUS AI

A secure, project-aware desktop engineering agent. Development follows the dependency order in the master specification; features are reported as implemented only after their backend, UI, permissions, error handling, documentation, and verification are in place.

## Repository audit

This repository was empty when work began: no source files, package manifests, dependencies, tests, or existing architecture were present. There is therefore no existing implementation to preserve or audit. This first commit establishes the project record and roadmap.

## Architecture direction

- Electron main process owns privileged desktop operations.
- Preload exposes a narrow validated IPC API.
- React renderer uses TypeScript and has no Node.js access.
- Express owns business logic behind REST contracts.
- Services and repositories isolate business logic from persistence.
- Gemini and Groq are the only planned AI providers.
- SQLite stores structured local data; files store snapshots and indexed artifacts.

## Dependency-aware roadmap

| Phase | Objective | Depends on | Main deliverables |
| --- | --- | --- | --- |
| 1. Project intelligence | Register projects, securely scan and incrementally index codebases | Foundation | Project registry, scanner, ignore/secrets policy, index versioning |
| 2. Context management | Retrieve ranked, sourced project/task context within limits | 1, storage | Context builder and retrieval contracts |
| 3. Code editing | Propose validated edits and reviewable diffs | 1, 2, 4 | Patch workflow, conflict checks, approval UI |
| 4. Version history | Snapshot, diff, restore, and audit file changes | Storage foundation | Hash-based snapshots and rollback |
| 5. Task planner | Persist plans, steps, dependencies, checkpoints, and verification | 2, tool registry | Background task lifecycle |
| 6. Terminal/process manager | Run bounded, permission-checked Windows commands and track processes | 5, tool registry | Process service and terminal UI |
| 7. Browser automation | Operate Playwright sessions with approval gates | 5, tool registry | Browser service and observation tools |
| 8. Vision | Analyze images/screenshots through supported Gemini models | Provider foundation | Capability-aware image analysis |
| 9. Agent roles | Coordinate bounded specialist roles through one orchestrator | 5, tool registry | Planner/coder/debugger/tester role definitions |
| 10. Workflows | Persist and execute reusable, permission-aware workflows | 5, 6, 7 | Workflow schema, runner, history |
| 11. Search | Add hybrid keyword/semantic retrieval with source references | 1, 2, 12 | Search index and ranking |
| 12. Memory | Manage inspectable, editable project/user memories | Storage foundation | Memory CRUD, history, secret exclusion |
| 13. Background events | Persist task state and stream progress | 5 | Event model and SSE |
| 14. Activity/notifications | Present structured operation events and desktop notifications | 13 | Activity center and notification service |
| 15. Analytics | Report only measured task/provider/tool usage | 5, 13 | Aggregates with provenance |
| 16. Settings | Secure provider credentials and configure permissions/models | Foundation, 8 | Settings service and control center |

## Implementation status

- **Audit:** Complete; repository was empty.
- **Roadmap:** Documented above.
- **Phase 1:** Not yet implemented.
- **Other phases:** Not implemented.
- **Production readiness:** No.

The next implementation slice is the Phase 1 project intelligence foundation. Each slice will be developed on a review branch and marked complete only after its acceptance criteria are verified.
