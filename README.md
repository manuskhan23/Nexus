# NEXUS AI

A secure, project-aware desktop engineering agent built incrementally from its master specification.

## Audit and architecture

The repository was empty at the start. The planned stack is Electron main/preload, a React TypeScript renderer, an Express API, MongoDB for structured state, filesystem snapshots/artifacts, and only Google Gemini and Groq as AI providers.

## Roadmap

| Phase | Objective | Depends on |
| --- | --- | --- |
| 1. Project intelligence | Register, scan, and incrementally index projects | Foundation |
| 2. Context management | Retrieve ranked, sourced context | 1 |
| 3. Code editing | Propose validated, reviewable changes | 1, 2, 4 |
| 4. Version history | Snapshot, compare, and restore files | Storage foundation |
| 5. Task planner | Persist plans and verified execution | 2, tool registry |
| 6. Terminal/process manager | Run bounded, permission-checked commands | 5 |
| 7. Browser automation | Automate Playwright with approval gates | 5 |
| 8. Vision | Analyze images through supported Gemini models | Provider foundation |
| 9. Agent roles | Coordinate specialist roles centrally | 5 |
| 10. Workflows | Execute reusable permission-aware workflows | 5, 6, 7 |
| 11. Search | Add hybrid retrieval and source references | 1, 2, 12 |
| 12. Memory | Manage inspectable user/project memories | Storage foundation |
| 13. Background events | Persist tasks and stream progress | 5 |
| 14. Activity/notifications | Present operation events and notifications | 13 |
| 15. Analytics | Report measured usage with provenance | 5, 13 |
| 16. Settings | Configure providers, models, and permissions | Foundation, 8 |

## Status

- Audit and roadmap: complete.
- Phase 1: scanner, MongoDB project registry/file index, REST project CRUD, and watcher-driven per-file updates are in progress.
- Full directory rescans occur for directory changes, missing filenames, ignore-file changes, and key package manifests.
- Remaining: Electron-mediated folder selection, renderer integration, access controls, complete ignore semantics, and verification.
- Other phases are not implemented. The product is not production-ready.

Set MONGODB_URI in the server process environment. MONGODB_DATABASE is optional and defaults to nexus. Never commit credentials.

Project registration currently accepts a path through the loopback API; restrict this to a directory selected and authorized by Electron main before desktop release. Removing a project deletes its metadata/index records, not project files.
