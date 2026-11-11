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

- Phase 1: bounded metadata scanning, MongoDB project/file records, project routes, watcher updates, and the Electron/React project workspace are implemented. Ignore semantics and watcher recovery still need more work.
- Phase 2: bounded keyword context retrieval is implemented. Search returns up to 8 source excerpts with file paths, line ranges, hashes, match reasons, and truncation status. It reads no more than 750 candidate files / 64 MiB and returns at most 16,000 excerpt characters.
- Source excerpts are labeled as untrusted repository content; the search service does not generate conclusions or execute project instructions.
- Semantic retrieval, conversation context, memory retrieval, and provider summarization are not implemented.
- Phase 4: local file snapshots, bounded line comparison, and hash-checked restore are implemented. Snapshots exclude secret-looking paths, binary files, symlinks, and files larger than 5 MiB; restore preserves a safety snapshot first.
- Phase 3 and Phases 5–16 remain open. The product is not production-ready.

Set MONGODB_URI in the environment available to the Electron process. MONGODB_DATABASE is optional and defaults to nexus. Never commit credentials.

Removing a project deletes its registry/index records but leaves project files untouched. Snapshot history remains in MongoDB and snapshot blobs remain under the app data directory. The scanner stores file metadata and hashes; context search reads bounded excerpts directly from project files on demand.
