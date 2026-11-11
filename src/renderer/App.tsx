import { useCallback, useEffect, useState } from "react";

interface Project {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  lastIndexedAt: string | null;
  indexVersion: number;
}
interface Scan {
  files: Array<{ path: string; language: string }>;
  scannedAt: string;
  languages: Record<string, number>;
  skipped: { ignored: number; secret: number; binaryOrUnsupported: number; oversized: number };
}
interface RegisteredProject {
  project: Project | null;
  scan?: Scan;
}
interface ProjectList {
  projects: Project[];
}
interface ContextSource {
  sourceType: "repository_file";
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  sha256: string;
  score: number;
  matchReasons: string[];
}
interface ContextResult {
  query: string;
  sources: ContextSource[];
  filesConsidered: number;
  truncated: boolean;
  note: string;
}
interface Snapshot {
  id: string;
  projectId: string;
  path: string;
  contentHash: string;
  size: number;
  mode: number;
  createdAt: string;
  reason: string;
}
interface SnapshotList {
  snapshots: Snapshot[];
}
interface SnapshotDiff {
  snapshot: Snapshot;
  currentHash: string | null;
  currentExists: boolean;
  added: string[];
  removed: string[];
  truncated: boolean;
}
interface EditableFile {
  path: string;
  exists: boolean;
  hash: string | null;
  content: string;
  size: number;
}
interface EditChange {
  path: string;
  action: "write" | "delete";
  expectedHash: string | null;
  size: number;
  currentHash: string | null;
  conflict: boolean;
  diff: string[];
  diffTruncated: boolean;
}
interface EditProposal {
  id: string;
  projectId: string;
  title: string;
  status: "pending" | "applying" | "applied" | "rejected" | "failed";
  createdAt: string;
  completedAt?: string;
  snapshotIds?: string[];
  failureMessage?: string;
  changes: EditChange[];
}
interface EditProposalList {
  proposals: Array<Omit<EditProposal, "changes"> & { changes: Array<{ path: string; action: "write" | "delete"; expectedHash: string | null; size: number }> }>;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [snapshotPath, setSnapshotPath] = useState("");
  const [results, setResults] = useState<Record<string, ContextResult>>({});
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot[]>>({});
  const [diffs, setDiffs] = useState<Record<string, SnapshotDiff>>({});
  const [editPath, setEditPath] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [drafts, setDrafts] = useState<Record<string, EditableFile>>({});
  const [editProposals, setEditProposals] = useState<Record<string, EditProposalList["proposals"]>>({});
  const [selectedEdits, setSelectedEdits] = useState<Record<string, EditProposal>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    const result = await window.nexus.projects.list() as ProjectList;
    setProjects(result.projects);
  }, []);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load projects");
    });
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation failed");
    } finally {
      setBusy(false);
    }
  }

  function addProject() {
    return run(async () => {
      const result = await window.nexus.projects.choose() as RegisteredProject | null;
      if (!result) return;
      await refresh();
      setNotice(`Indexed ${result.scan?.files.length ?? 0} files.`);
    });
  }

  function rescan(project: Project) {
    return run(async () => {
      const result = await window.nexus.projects.scan(project.id) as RegisteredProject;
      await refresh();
      setNotice(`Updated index for ${project.name}: ${result.scan?.files.length ?? 0} files.`);
    });
  }

  function search(project: Project) {
    return run(async () => {
      const result = await window.nexus.projects.searchContext(project.id, query) as ContextResult;
      setResults((current) => ({ ...current, [project.id]: result }));
    });
  }

  function loadSnapshots(project: Project) {
    return run(async () => {
      const result = await window.nexus.snapshots.list(project.id, snapshotPath.trim() || undefined) as SnapshotList;
      setSnapshots((current) => ({ ...current, [project.id]: result.snapshots }));
    });
  }

  function createSnapshot(project: Project) {
    return run(async () => {
      const relativePath = snapshotPath.trim();
      if (!relativePath) throw new Error("Enter a project-relative file path first");
      await window.nexus.snapshots.create(project.id, relativePath, "Manual recovery point");
      const list = await window.nexus.snapshots.list(project.id, relativePath) as SnapshotList;
      setSnapshots((current) => ({ ...current, [project.id]: list.snapshots }));
      setNotice(`Saved a recovery point for ${relativePath}.`);
    });
  }

  function compareSnapshot(project: Project, snapshot: Snapshot) {
    return run(async () => {
      const comparison = await window.nexus.snapshots.diff(project.id, snapshot.id) as SnapshotDiff;
      setDiffs((current) => ({ ...current, [snapshot.id]: comparison }));
    });
  }

  function restoreSnapshot(project: Project, snapshot: Snapshot) {
    return run(async () => {
      const comparison = await window.nexus.snapshots.diff(project.id, snapshot.id) as SnapshotDiff;
      const accepted = window.confirm(
        `Restore ${snapshot.path} from ${new Date(snapshot.createdAt).toLocaleString()}? The current file will be preserved as a safety snapshot.`
      );
      if (!accepted) return;
      await window.nexus.snapshots.restore(project.id, snapshot.id, comparison.currentHash);
      const list = await window.nexus.snapshots.list(project.id, snapshot.path) as SnapshotList;
      setSnapshots((current) => ({ ...current, [project.id]: list.snapshots }));
      setDiffs((current) => {
        const next = { ...current };
        delete next[snapshot.id];
        return next;
      });
      setNotice(`Restored ${snapshot.path}. A safety snapshot was kept in history.`);
    });
  }

  function loadEditFile(project: Project) {
    return run(async () => {
      const filePath = editPath.trim();
      if (!filePath) throw new Error("Enter a project-relative path to inspect");
      const file = await window.nexus.files.read(project.id, filePath) as EditableFile;
      setDrafts((current) => ({ ...current, [project.id]: file }));
      setNotice(file.exists ? `Loaded ${file.path} at hash ${file.hash?.slice(0, 12)}.` : `${file.path} will be created when the proposal is applied.`);
    });
  }

  function stageEdit(project: Project, action: "write" | "delete") {
    return run(async () => {
      const draft = drafts[project.id];
      if (!draft) throw new Error("Inspect the file before staging a change");
      if (action === "delete" && !draft.exists) throw new Error("The file does not exist");
      const result = await window.nexus.edits.propose(project.id, editTitle.trim() || `Edit ${draft.path}`, [{
        path: draft.path,
        action,
        expectedHash: draft.hash,
        ...(action === "write" ? { content: draft.content } : {})
      }]) as EditProposal;
      const list = await window.nexus.edits.list(project.id) as EditProposalList;
      setEditProposals((current) => ({ ...current, [project.id]: list.proposals }));
      setSelectedEdits((current) => ({ ...current, [project.id]: result }));
      setNotice(`Prepared ${action} proposal for ${draft.path}. Review its diff before applying.`);
    });
  }

  function loadEditProposals(project: Project) {
    return run(async () => {
      const list = await window.nexus.edits.list(project.id) as EditProposalList;
      setEditProposals((current) => ({ ...current, [project.id]: list.proposals }));
    });
  }

  function inspectEditProposal(project: Project, proposalId: string) {
    return run(async () => {
      const proposal = await window.nexus.edits.get(project.id, proposalId) as EditProposal;
      setSelectedEdits((current) => ({ ...current, [project.id]: proposal }));
    });
  }

  function applyEditProposal(project: Project, proposal: EditProposal) {
    return run(async () => {
      if (proposal.changes.some((change) => change.conflict)) {
        throw new Error("A file changed after this proposal was prepared. Reject it and prepare a new proposal.");
      }
      const accepted = window.confirm(`Apply “${proposal.title}” to ${proposal.changes.length} file(s)? A recovery snapshot will be saved first.`);
      if (!accepted) return;
      await window.nexus.edits.apply(project.id, proposal.id);
      const [list, updated] = await Promise.all([
        window.nexus.edits.list(project.id) as Promise<EditProposalList>,
        window.nexus.edits.get(project.id, proposal.id) as Promise<EditProposal>
      ]);
      setEditProposals((current) => ({ ...current, [project.id]: list.proposals }));
      setSelectedEdits((current) => ({ ...current, [project.id]: updated }));
      const draft = drafts[project.id];
      if (draft) {
        const refreshed = await window.nexus.files.read(project.id, draft.path) as EditableFile;
        setDrafts((current) => ({ ...current, [project.id]: refreshed }));
      }
      setNotice("Proposal applied and recovery snapshots recorded.");
    });
  }

  function rejectEditProposal(project: Project, proposal: EditProposal) {
    return run(async () => {
      await window.nexus.edits.reject(project.id, proposal.id);
      const list = await window.nexus.edits.list(project.id) as EditProposalList;
      setEditProposals((current) => ({ ...current, [project.id]: list.proposals }));
      const updated = await window.nexus.edits.get(project.id, proposal.id) as EditProposal;
      setSelectedEdits((current) => ({ ...current, [project.id]: updated }));
      setNotice("Edit proposal rejected.");
    });
  }

  function removeProject(project: Project) {
    return run(async () => {
      await window.nexus.projects.remove(project.id);
      await refresh();
      setResults((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      setSnapshots((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      setNotice(`Removed ${project.name} from the workspace. Project files were left untouched.`);
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">NEXUS AI / WORKSPACE</p>
          <h1>Projects</h1>
        </div>
        <button className="primary-button" onClick={addProject} disabled={busy}>
          {busy ? "Working…" : "Add project"}
        </button>
      </header>

      <section className="intro">
        <p className="intro-title">Project intelligence</p>
        <p className="muted">Search indexed files and create recoverable file snapshots.</p>
      </section>

      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message" role="status">{notice}</div>}

      <section className="project-list" aria-label="Registered projects">
        {projects.length === 0 ? (
          <div className="empty-state">
            <span className="empty-mark">N</span>
            <h2>No projects connected</h2>
            <p className="muted">Choose a local project folder to start its first scan.</p>
            <button className="secondary-button" onClick={addProject} disabled={busy}>Choose folder</button>
          </div>
        ) : projects.map((project) => {
          const context = results[project.id];
          return (
            <article className="project-card" key={project.id}>
              <div className="project-heading">
                <div>
                  <h2>{project.name}</h2>
                  <p className="project-path">{project.root}</p>
                </div>
                <span className="index-badge">INDEX {project.indexVersion}</span>
              </div>
              <p className="muted small">
                {project.lastIndexedAt ? `Last indexed ${new Date(project.lastIndexedAt).toLocaleString()}` : "Not indexed"}
              </p>
              <div className="actions">
                <button className="secondary-button" onClick={() => void rescan(project)} disabled={busy}>Rescan</button>
                <button className="text-button" onClick={() => void removeProject(project)} disabled={busy}>Remove</button>
              </div>

              <section className="edit-panel">
                <h3>Reviewable code edits</h3>
                <p className="muted small">Inspect a project file, stage a change, review the diff, then approve or reject it. Project files stay local.</p>
                <div className="search-row">
                  <input value={editPath} onChange={(event) => setEditPath(event.target.value)}
                    maxLength={4096} placeholder="src/components/App.tsx" aria-label="File to edit" />
                  <button className="secondary-button" onClick={() => void loadEditFile(project)} disabled={busy}>Inspect</button>
                </div>
                {drafts[project.id] && (
                  <div className="edit-draft">
                    <p className="muted small">
                      {drafts[project.id].exists ? `Current hash ${drafts[project.id].hash}` : "New file"}
                    </p>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)}
                      maxLength={160} placeholder="Change title" aria-label="Change title" />
                    <textarea value={drafts[project.id].content}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [project.id]: { ...current[project.id], content: event.target.value }
                      }))}
                      maxLength={1_000_000} spellCheck={false} aria-label="Proposed file content" />
                    <div className="actions">
                      <button className="secondary-button" onClick={() => void stageEdit(project, "write")} disabled={busy}>Review change</button>
                      {drafts[project.id].exists &&
                        <button className="text-button" onClick={() => void stageEdit(project, "delete")} disabled={busy}>Propose delete</button>}
                      <button className="text-button" onClick={() => void loadEditProposals(project)} disabled={busy}>Edit history</button>
                    </div>
                  </div>
                )}
                {(editProposals[project.id] ?? []).length > 0 && (
                  <div className="edit-history">
                    {(editProposals[project.id] ?? []).map((proposal) => (
                      <button className="edit-history-item" key={proposal.id}
                        onClick={() => void inspectEditProposal(project, proposal.id)} disabled={busy}>
                        {proposal.title} · {proposal.status} · {proposal.changes.length} file(s)
                      </button>
                    ))}
                  </div>
                )}
                {selectedEdits[project.id] && (
                  <div className="edit-review">
                    <div className="project-heading">
                      <strong>{selectedEdits[project.id].title}</strong>
                      <span className="index-badge">{selectedEdits[project.id].status.toUpperCase()}</span>
                    </div>
                    {selectedEdits[project.id].changes.map((change) => (
                      <section className="source-result" key={change.path}>
                        <div className="source-heading"><strong>{change.path} · {change.action}</strong>
                          <span>{change.conflict ? "CONFLICT" : "READY"}</span></div>
                        <pre className="diff-view">{change.diff.join("\n")}{change.diffTruncated ? "\n… diff is bounded" : ""}</pre>
                      </section>
                    ))}
                    {selectedEdits[project.id].status === "pending" && (
                      <div className="actions">
                        <button className="primary-button" onClick={() => void applyEditProposal(project, selectedEdits[project.id])}
                          disabled={busy || selectedEdits[project.id].changes.some((change) => change.conflict)}>Apply approved change</button>
                        <button className="text-button" onClick={() => void rejectEditProposal(project, selectedEdits[project.id])} disabled={busy}>Reject</button>
                      </div>
                    )}
                    {selectedEdits[project.id].failureMessage &&
                      <p className="message error">{selectedEdits[project.id].failureMessage}</p>}
                  </div>
                )}
              </section>

              <form className="context-search" onSubmit={(event) => { event.preventDefault(); void search(project); }}>
                <label htmlFor={`query-${project.id}`}>Find relevant code</label>
                <div className="search-row">
                  <input id={`query-${project.id}`} value={query} onChange={(event) => setQuery(event.target.value)}
                    maxLength={512} placeholder="Ask about a function, module, or behavior" />
                  <button className="secondary-button" type="submit" disabled={busy || query.trim().length < 2}>Search</button>
                </div>
              </form>
              {context && (
                <div className="context-results" aria-live="polite">
                  <p className="muted small">
                    {context.sources.length} source excerpts from up to {context.filesConsidered} indexed files
                    {context.truncated ? " · search was bounded" : ""}
                  </p>
                  {context.sources.length === 0 ? <p className="muted">No matching source excerpts found.</p> :
                    context.sources.map((source) => (
                      <section className="source-result" key={source.path}>
                        <div className="source-heading">
                          <strong>{source.path}</strong>
                          <span>lines {source.startLine}–{source.endLine}</span>
                        </div>
                        <pre>{source.excerpt}</pre>
                        <p className="muted source-note">{source.matchReasons.join(" · ")} · source text, not an AI conclusion</p>
                      </section>
                    ))}
                </div>
              )}

              <section className="snapshot-panel">
                <h3>File history</h3>
                <p className="muted small">Snapshots are local recovery copies. Enter a project-relative path.</p>
                <div className="search-row">
                  <input value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)}
                    maxLength={4096} placeholder="src/components/App.tsx" aria-label="Project-relative file path" />
                  <button className="secondary-button" onClick={() => void createSnapshot(project)} disabled={busy}>Save snapshot</button>
                  <button className="text-button" onClick={() => void loadSnapshots(project)} disabled={busy}>History</button>
                </div>
                {(snapshots[project.id] ?? []).map((snapshot) => {
                  const diff = diffs[snapshot.id];
                  return (
                    <div className="snapshot-row" key={snapshot.id}>
                      <div className="snapshot-meta">
                        <strong>{snapshot.path}</strong>
                        <span>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.reason}</span>
                      </div>
                      <div className="snapshot-buttons">
                        <button className="text-button" onClick={() => void compareSnapshot(project, snapshot)} disabled={busy}>Compare</button>
                        <button className="text-button" onClick={() => void restoreSnapshot(project, snapshot)} disabled={busy}>Restore</button>
                      </div>
                      {diff && (
                        <pre className="diff-view">
                          {diff.currentExists ? `Current file hash: ${diff.currentHash}` : "Current file is missing"}
                          {diff.removed.map((line, index) => `\n- ${line}`)}
                          {diff.added.map((line, index) => `\n+ ${line}`)}
                          {diff.truncated ? "\n… diff is bounded" : ""}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </section>
            </article>
          );
        })}
      </section>

      <footer>PHASE 3 · REVIEWABLE EDITS · SNAPSHOT BEFORE APPLY</footer>
    </main>
  );
}
