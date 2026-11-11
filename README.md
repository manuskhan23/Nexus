# NEXUS AI

A secure, project-aware desktop engineering agent built incrementally from its master specification.

## Audit and architecture

The repository was empty at the start. The stack is Electron main/preload, a React TypeScript renderer, an Express API, MongoDB for structured state, filesystem snapshots/artifacts, and only Google Gemini and Groq as AI providers.

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

- Phase 1 includes bounded metadata scanning, MongoDB project/file records, project REST operations, debounced watcher updates, and a monochrome React project screen.
- Electron main opens the folder picker; the renderer receives only project operations through a restricted preload API. The API uses a per-launch token held in main.
- Full rescans handle directory changes, missing filenames, ignore-file changes, and key manifests. Ordinary file changes update a single metadata record.
- Remaining: complete ignore semantics, robust watcher recovery, provider integrations, and local build/runtime verification.
- Phases 2–16 are not implemented. The product is not production-ready.

Set MONGODB_URI in the environment available to the Electron process. MONGODB_DATABASE is optional and defaults to nexus. Never commit credentials.

Removing a project deletes its registry/index records but leaves project files untouched. The scanner stores metadata and hashes, not source contents.
