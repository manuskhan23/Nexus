# NEXUS AI

A secure, project-aware desktop engineering agent, developed incrementally from its master specification.

## Repository audit

The repository was empty at the start: no source files, package manifests, dependencies, tests, or existing architecture were present.

## Architecture direction

- Electron main owns privileged desktop operations; preload exposes a narrow validated IPC API.
- React renderer uses TypeScript and has no Node.js access.
- Express owns business logic behind REST contracts.
- Services isolate business logic from persistence.
- Google Gemini and Groq are the only planned AI providers.
- MongoDB stores structured application data; the filesystem stores snapshots and artifacts.
- MongoDB credentials are read from environment configuration and must never be committed.

## Dependency-aware roadmap

| Phase | Objective | Depends on | Main deliverables |
| --- | --- | --- | --- |
| 1. Project intelligence | Register, scan, and incrementally index codebases | Foundation | Registry, scanner, ignore/secrets policy, index versions |
| 2. Context management | Retrieve sourced project/task context within limits | 1 | Ranking, context builder, source tracking |
| 3. Code editing | Propose validated, reviewable changes | 1, 2, 4 | Patches, conflict checks, approval UI |
| 4. Version history | Snapshot, compare, and restore file states | Storage foundation | Hash snapshots and rollback |
| 5. Task planner | Persist plans and verified execution steps | 2, tool registry | Background task lifecycle |
| 6. Terminal/process manager | Run bounded, permission-checked commands | 5 | Process service and terminal UI |
| 7. Browser automation | Automate Playwright sessions with approval gates | 5 | Browser service and observations |
| 8. Vision | Analyze images through supported Gemini models | Provider foundation | Capability-aware image analysis |
| 9. Agent roles | Coordinate specialist roles through one orchestrator | 5 | Planner/coder/debugger/tester roles |
| 10. Workflows | Execute reusable permission-aware workflows | 5, 6, 7 | Workflow model, runner, history |
| 11. Search | Add hybrid retrieval with source references | 1, 2, 12 | Search index and ranking |
| 12. Memory | Manage inspectable user/project memories | Storage foundation | Memory CRUD and history |
| 13. Background events | Persist tasks and stream progress | 5 | Event model and SSE |
| 14. Activity/notifications | Present operation events and notifications | 13 | Activity center |
| 15. Analytics | Report measured task/provider/tool usage | 5, 13 | Provenance-aware aggregates |
| 16. Settings | Configure providers, models, permissions, and app | Foundation, 8 | Secure settings service |

## Implementation status

- **Audit and roadmap:** Complete.
- **Phase 1:** In progress. A bounded metadata scanner and MongoDB project/file-index store are implemented on the current review branch. Express routes list, register, rescan, and remove project records.
- **Phase 1 remaining:** Incremental file updates, filesystem watchers, Electron-mediated folder selection, frontend integration, full ignore semantics, API access controls, and verification.
- **Other phases:** Not implemented.
- **Verification:** Not run; changes were made through GitHub without a local checkout/runtime.
- **Production readiness:** No.

Registration currently accepts a filesystem path over the loopback API; it must be limited to paths selected and authorized by Electron main before desktop release. Removing a project only removes its registry/index records, not its files.

## Configuration

Set MONGODB_URI in the process environment. MONGODB_DATABASE is optional and defaults to nexus. Do not commit credentials or place them in renderer-visible settings.