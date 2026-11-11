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

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
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

  function removeProject(project: Project) {
    return run(async () => {
      await window.nexus.projects.remove(project.id);
      await refresh();
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
        <p className="muted">Register a folder to scan source metadata and keep its index current.</p>
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
        ) : projects.map((project) => (
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
          </article>
        ))}
      </section>

      <footer>PHASE 1 · PROJECT INTELLIGENCE · INDEXING IS METADATA ONLY</footer>
    </main>
  );
}
