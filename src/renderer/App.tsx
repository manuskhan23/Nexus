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

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [snapshotPath, setSnapshotPath] = useState("");
  const [results, setResults] = useState<Record<string, ContextResult>>({});
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot[]>>({});
  const [diffs, setDiffs] = useState<Record<string, SnapshotDiff>>({});
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

      <footer>PHASE 4 · VERSION HISTORY · RESTORE CHECKS FILE HASHES</footer>
    </main>
  );
}
