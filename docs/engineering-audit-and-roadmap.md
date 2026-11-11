# NEXUS AI engineering audit and roadmap

Audit date: 2026-11-11
Baseline: `main` at merge commit `76401e96476a1f59af717cd91d08f05f55e3ab21`

## Repository audit

### Architecture present
- Electron main process, restricted preload bridge, React/TypeScript renderer, Express REST API.
- MongoDB stores project and indexed-file metadata. Filesystem snapshots are stored under the app data directory.
- Project scanning is bounded, skips common generated folders, secret-looking files, symlinks, binary/unsupported files, and oversized files.
- File changes are watched and update the MongoDB index.
- Context search is bounded keyword retrieval with source paths, line ranges, hashes, reasons, and truncation metadata.
- File-level snapshot create/list/compare/restore is implemented. Restore verifies the compared current hash and saves a safety snapshot first.
- API routes are protected by a random per-launch bearer token; IPC checks the trusted renderer frame and exposes narrow methods.

### Gaps and risks
- The repository contains no automated test suite or test script. CI currently runs only TypeScript typecheck and production build.
- No AI chat, provider clients, model router, agent loop, tool registry, task persistence, code editing, terminal, Playwright browser service, vision, workflows, semantic search, memory, background events, notifications, analytics, or settings UI/services exist.
- Project summaries and structural symbol/dependency analysis are absent; context search is keyword-only.
- Version history does not yet include project-wide snapshots, redo, content-hash deduplication, or automatic snapshots for code edits.
- Electron security headers/CSP and secure OS credential storage are not yet implemented.
- Dependencies are minimal; Gemini/Groq SDKs, Playwright, and test tooling are not installed.
- The supplied specification prefers SQLite, but the user explicitly selected MongoDB earlier. Continue with MongoDB and keep storage behind service/repository interfaces; do not migrate data to SQLite without the user's direction.

## Completion matrix

| Phase | Status | Evidence / remaining acceptance work |
| --- | --- | --- |
| 1. Project intelligence | Partial | Bounded scan/index/watch exists; add correct nested ignore semantics, recovery, richer structural analysis and generated summaries. |
| 2. Context management | Partial | Bounded keyword excerpts exist; add conversation/task layers, memory retrieval, deduplication and model-budget accounting. |
| 3. Code editing | Partial | Safe read/create/modify/delete/move, local staged multi-file proposals, bounded diffs, explicit approval, conflict detection, and pre-edit snapshots exist. AI-generated proposals and automated test execution in the apply lifecycle remain. |
| 4. Version history | Partial | File snapshot/compare/hash-checked restore exists; connect every edit to operation history, add project snapshots and deduplication. |
| 5. Task planner | Partial | Persisted plans, dependency DAG validation, inspectable progress/events, controlled task/step transitions, priority, and secret redaction exist. AI planning, tool execution, background persistence/recovery and robust cancel/retry checkpoints remain. |
| 6. Terminal/process manager | Partial | Windows-only PowerShell/CMD runner, explicit approval, registered-project working directory confinement, minimal child environment, bounded output/time, and owned process tracking are implemented. Bounded output/status polling and live cancellation are wired through API/IPC/UI. Windows CI validates CMD execution/output and PowerShell timeout/termination. The one-shot PowerShell output test hangs without output and remains tracked for the final Windows pass. Process state is in-memory and does not recover after app restart. |
| 7. Browser automation | Partial | Isolated headless Chromium session, bounded text snapshots, HTTP(S) navigation, private/reserved address filtering, and approval-gated navigation/click/fill/close through tool registry/API/IPC/UI. Add browser events, screenshot/vision, restart recovery, and scenario tests. |
| 8. Vision | Not implemented | Gemini-only multimodal analysis, model capability checks and screenshot attachment path. |
| 9. Agent roles | Not implemented | Central orchestrator and bounded specialist roles sharing task state. |
| 10. Workflows | Not implemented | Persisted, permission-aware workflow definitions and executions. |
| 11. Search | Partial | Keyword retrieval exists; add hybrid/semantic retrieval, source references and search across memories/history. |
| 12. Memory | Not implemented | Inspectable/editable user and project memories with secret filtering and disable/export controls. |
| 13. Background tasks/events | Not implemented | Durable execution state, recovery, cancellation and SSE progress events. |
| 14. Activity/notifications | Not implemented | Structured audit events, activity UI and Windows notifications. |
| 15. Analytics | Not implemented | Provenance-backed task/provider/tool usage metrics; no fabricated estimates. |
| 16. Settings | Not implemented | Provider/model configuration, secure credential storage, execution limits, approvals, project preferences and data controls. |

## Dependency-aware implementation roadmap

Complete one vertical slice at a time on the feature branch. Each slice must include backend services, API contracts, restricted IPC, renderer states, validation, documentation, and CI verification.

1. **Phase 3: reviewable code editing** (unblocked by phases 1, 2, 4). Stage changes, show diffs, require approval, verify file hashes at apply time, snapshot before write, and record operation metadata. Acceptance: create/modify/move/delete operations are path-safe; stale changes are rejected; restore is possible; renderer never receives privileged filesystem APIs.
2. **Storage foundation and Phase 12: memory**. Extend Mongo repositories with schema validation/indexes and migrations/versioning. Add secret-safe, inspectable memory CRUD and project association.
3. **Phase 5 + 13: task planner/background execution**. Persist tasks/steps/events and implement bounded workers, checkpointing, pause/resume/cancel/retry, SSE progress, and restart recovery.
4. **Tool registry and Phase 6: terminal/process manager**. The central registry now connects to a Windows runner with bounded output/status polling and live cancellation. Matrix CI validates CMD execution/output and PowerShell timeout/termination. A one-shot PowerShell command hangs without output in the Windows runner and remains tracked for the final Windows pass. Process state is in-memory, so restart recovery also remains before this phase can be complete. Every command requires explicit approval; execution is bounded and scoped to a registered project.
5. **Phase 7: Playwright browser automation**. A first vertical slice now has project-owned headless sessions, bounded text snapshots, constrained HTTP(S) navigation with private-address filtering, and approval-gated navigation/click/fill/close through the tool/API/IPC/UI. Add browser event capture, screenshot/vision support, process-restart handling, and desktop scenario coverage.
6. **Phase 8 + 16: provider routing and settings**. Add only Gemini and Groq adapters, capability-aware routing, secure OS credential storage, privacy/fallback settings and execution limits.
7. **Phase 9: specialist roles**. Add logical planning/coding/debugging/testing/analysis/browser/documentation roles behind the centralized orchestrator.
8. **Phase 10: workflows**. Persist typed workflow steps, approvals, execution state and history using the task/tool infrastructure.
9. **Phase 1/2/11 improvements**. Add symbol/dependency analysis, robust ignore/watcher recovery, context layering, semantic/hybrid search and source-aware retrieval.
10. **Phase 14/15: activity/notifications/analytics**. Derive every displayed metric from persisted events/provider reports; add activity filters and Windows notifications.
11. **Integration and final validation**. Add deterministic tests with mocked providers, API/storage/security/IPC/tool tests, then scenario-level desktop validation. Keep product status explicitly non-production until critical acceptance tests pass.

## Cross-cutting acceptance gates
- Only Gemini and Groq may be integrated.
- MongoDB remains the selected structured store, behind repository/service interfaces.
- Renderer has no direct Node access; every privileged action passes validated IPC and a backend permission check.
- Source files, website content, and tool output remain untrusted context and cannot change policies.
- High-risk operations require human approval; all tool operations have bounded duration/size and structured audit events.
- Never log credentials, claim unverified outcomes, or delete rollback data without a defined retention policy.
