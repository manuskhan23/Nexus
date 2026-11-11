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

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, ContextResult>>({});
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

  function removeProject(project: Project) {
    return run(async () => {
      await window.nexus.projects.remove(project.id);
      await refresh();
      setResults((current) => {
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
        <p className="muted">Search indexed project files and inspect bounded, line-referenced source context.</p>
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
                  <input
                    id={`query-${project.id}`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    maxLength={512}
                    placeholder="Ask about a function, module, or behavior"
                  />
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
            </article>
          );
        })}
      </section>

      <footer>PHASE 2 · CONTEXT RETRIEVAL · SOURCED EXCERPTS ONLY</footer>
    </main>
  );
}
