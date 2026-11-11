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
  action: "write" | "delete" | "move";
  expectedHash: string | null;
  destinationPath?: string;
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
  proposals: Array<Omit<EditProposal, "changes"> & { changes: Array<{ path: string; action: "write" | "delete" | "move"; expectedHash: string | null; destinationPath?: string; size: number }> }>;
}
interface DraftChange {
  path: string;
  action: "write" | "delete" | "move";
  expectedHash: string | null;
  destinationPath?: string;
  content?: string;
}
interface TaskStep {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}
interface TaskEvent {
  id: string;
  at: string;
  type: string;
  message: string;
}
interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high";
  status: "pending" | "planning" | "awaiting_approval" | "running" | "paused" | "failed" | "completed" | "cancelled";
  steps: TaskStep[];
  progress: number;
  currentStepId: string | null;
  error?: string;
  events: TaskEvent[];
}
interface TaskList { tasks: Task[] }
interface TerminalResult {
  processId: string;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}
interface BrowserSnapshot {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}
interface BrowserSessionView extends BrowserSnapshot {}

interface TerminalProcesses { processes: TerminalResult[] }

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
  const [moveDestination, setMoveDestination] = useState("");
  const [drafts, setDrafts] = useState<Record<string, EditableFile>>({});
  const [editBatch, setEditBatch] = useState<Record<string, DraftChange[]>>({});
  const [editProposals, setEditProposals] = useState<Record<string, EditProposalList["proposals"]>>({});
  const [selectedEdits, setSelectedEdits] = useState<Record<string, EditProposal>>({});
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPlan, setTaskPlan] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "normal" | "high">("normal");
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({});
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalShell, setTerminalShell] = useState<"powershell" | "cmd">("powershell");
  const [terminalCwd, setTerminalCwd] = useState("");
  const [terminalResults, setTerminalResults] = useState<Record<string, TerminalResult>>({});
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserSelector, setBrowserSelector] = useState("");
  const [browserValue, setBrowserValue] = useState("");
  const [browserByProject, setBrowserByProject] = useState<Record<string, BrowserSessionView>>({});
  const [terminalProcesses, setTerminalProcesses] = useState<Record<string, TerminalResult[]>>({});
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

  useEffect(() => {
    const active = Object.entries(terminalProcesses).flatMap(([projectId, processes]) =>
      processes.filter((item) => item.status === "running").map((item) => ({ projectId, processId: item.processId }))
    );
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      void Promise.all(active.map(async ({ projectId, processId }) => {
        try {
          return { projectId, result: await window.nexus.terminal.getProcess(projectId, processId) as TerminalResult };
        } catch {
          return null;
        }
      })).then((updates) => {
        const valid = updates.filter((item): item is { projectId: string; result: TerminalResult } => item !== null);
        if (!valid.length) return;
        setTerminalResults((current) => {
          const next = { ...current };
          for (const item of valid) next[item.projectId] = item.result;
          return next;
        });
        setTerminalProcesses((current) => {
          const next = { ...current };
          for (const item of valid) {
            next[item.projectId] = (next[item.projectId] ?? []).map((process) => process.processId === item.result.processId
              ? item.result : process).filter((process) => process.status === "running");
          }
          return next;
        });
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [terminalProcesses]);

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

  function runTerminal(project: Project) {
    return run(async () => {
      const command = terminalCommand.trim();
      if (!command) throw new Error("Enter a command to run");
      const approved = window.confirm(`Run this ${terminalShell} command in ${project.name}${terminalCwd.trim() ? " / " + terminalCwd.trim() : ""}?\n\n${command}\n\nThe command can change project files or run other programs.`);
      if (!approved) return;
      const started = await window.nexus.terminal.run(project.id, {
        command, shell: terminalShell, cwd: terminalCwd.trim() || undefined
      }, true) as { processId: string };
      const [result, processList] = await Promise.all([
        window.nexus.terminal.getProcess(project.id, started.processId) as Promise<TerminalResult>,
        window.nexus.terminal.listProcesses(project.id) as Promise<TerminalProcesses>
      ]);
      setTerminalResults((current) => ({ ...current, [project.id]: result }));
      setTerminalProcesses((current) => ({ ...current, [project.id]: processList.processes }));
      setNotice("Command started. Output and status update while it runs.");
    });
  }

  function loadTerminalProcesses(project: Project) {
    return run(async () => {
      const result = await window.nexus.terminal.listProcesses(project.id) as TerminalProcesses;
      setTerminalProcesses((current) => ({ ...current, [project.id]: result.processes }));
    });
  }

  function stopTerminalProcess(project: Project, processId: string) {
    return run(async () => {
      const approved = window.confirm(`Stop process ${processId}? This terminates the process tree.`);
      if (!approved) return;
      await window.nexus.terminal.cancel(project.id, processId, true);
      const result = await window.nexus.terminal.listProcesses(project.id) as TerminalProcesses;
      setTerminalProcesses((current) => ({ ...current, [project.id]: result.processes }));
    });
  }

  function startBrowser(project: Project) {
    return run(async () => {
      const approved = window.confirm(`Start an isolated headless Chromium session for ${project.name}? Page content will be treated as untrusted text.`);
      if (!approved) return;
      const result = await window.nexus.browser.start(project.id, true) as { sessionId: string };
      const initial = await window.nexus.browser.snapshot(project.id, result.sessionId) as BrowserSnapshot;
      setBrowserByProject((current) => ({ ...current, [project.id]: initial }));
      setNotice("Browser session started. Chromium browser binaries may need installation on this computer.");
    });
  }

  function navigateBrowser(project: Project) {
    return run(async () => {
      const session = browserByProject[project.id];
      const url = browserUrl.trim();
      if (!session) throw new Error("Start a browser session first");
      if (!url) throw new Error("Enter a complete http or https URL");
      const approved = window.confirm(`Navigate the isolated browser to this URL?\n\n${url}\n\nThe page may load remote content; private/local destinations are restricted unless explicitly approved by the service.`);
      if (!approved) return;
      const snapshot = await window.nexus.browser.navigate(project.id, session.sessionId, url, true) as BrowserSnapshot;
      setBrowserByProject((current) => ({ ...current, [project.id]: snapshot }));
    });
  }

  function refreshBrowser(project: Project) {
    return run(async () => {
      const session = browserByProject[project.id];
      if (!session) throw new Error("Start a browser session first");
      const snapshot = await window.nexus.browser.snapshot(project.id, session.sessionId) as BrowserSnapshot;
      setBrowserByProject((current) => ({ ...current, [project.id]: snapshot }));
    });
  }

  function clickBrowser(project: Project) {
    return run(async () => {
      const session = browserByProject[project.id];
      const selector = browserSelector.trim();
      if (!session || !selector) throw new Error("Start a session and enter a selector");
      const approved = window.confirm(`Click the first element matching this selector on ${session.url}?\n\n${selector}`);
      if (!approved) return;
      const snapshot = await window.nexus.browser.click(project.id, session.sessionId, selector, true) as BrowserSnapshot;
      setBrowserByProject((current) => ({ ...current, [project.id]: snapshot }));
    });
  }

  function fillBrowser(project: Project) {
    return run(async () => {
      const session = browserByProject[project.id];
      const selector = browserSelector.trim();
      if (!session || !selector) throw new Error("Start a session and enter a selector");
      const approved = window.confirm(`Fill the first matching field on ${session.url}?\n\nSelector: ${selector}\nText: ${browserValue}`);
      if (!approved) return;
      const snapshot = await window.nexus.browser.fill(project.id, session.sessionId, selector, browserValue, true) as BrowserSnapshot;
      setBrowserByProject((current) => ({ ...current, [project.id]: snapshot }));
    });
  }

  function closeBrowser(project: Project) {
    return run(async () => {
      const session = browserByProject[project.id];
      if (!session) return;
      const approved = window.confirm(`Close the isolated browser session for ${project.name}?`);
      if (!approved) return;
      await window.nexus.browser.close(project.id, session.sessionId, true);
      setBrowserByProject((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      setNotice("Browser session closed.");
    });
  }

  function loadTasks(project: Project) {
    return run(async () => {
      const result = await window.nexus.tasks.list(project.id) as TaskList;
      setTasksByProject((current) => ({ ...current, [project.id]: result.tasks }));
    });
  }

  function createPlannedTask(project: Project) {
    return run(async () => {
      const lines = taskPlan.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length) throw new Error("Enter at least one plan step");
      const steps = lines.map((title, index) => ({
        title,
        dependencies: index === 0 ? [] : [index - 1]
      }));
      await window.nexus.tasks.create(project.id, {
        title: taskTitle,
        description: taskDescription,
        priority: taskPriority,
        steps
      });
      const result = await window.nexus.tasks.list(project.id) as TaskList;
      setTasksByProject((current) => ({ ...current, [project.id]: result.tasks }));
      setTaskTitle("");
      setTaskDescription("");
      setTaskPlan("");
      setNotice("Task and dependency plan saved.");
    });
  }

  async function updateTask(project: Project, task: Task, status: Task["status"], note = "") {
    const result = await window.nexus.tasks.setStatus(project.id, task.id, status, note) as { task: Task };
    setTasksByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).map((item) => item.id === task.id ? result.task : item)
    }));
  }

  async function updateTaskStep(project: Project, task: Task, step: TaskStep, status: TaskStep["status"]) {
    const result = await window.nexus.tasks.setStep(project.id, task.id, step.id, status) as { task: Task };
    setTasksByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).map((item) => item.id === task.id ? result.task : item)
    }));
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

  function queueEditChange(project: Project, action: "write" | "delete" | "move") {
    return run(async () => {
      const draft = drafts[project.id];
      if (!draft) throw new Error("Inspect the file before staging a change");
      if (action !== "write" && !draft.exists) throw new Error("The file does not exist");
      if (action === "move" && !moveDestination.trim()) throw new Error("Enter a destination path for the move");
      const batch = editBatch[project.id] ?? [];
      if (batch.some((change) => change.path === draft.path)) throw new Error("This file is already in the proposal batch");
      if (batch.length >= 19) throw new Error("A proposal can contain at most 20 file changes");
      const change: DraftChange = {
        path: draft.path,
        action,
        expectedHash: draft.hash,
        ...(action === "write" ? { content: draft.content } : {}),
        ...(action === "move" ? { destinationPath: moveDestination.trim() } : {})
      };
      setEditBatch((current) => ({ ...current, [project.id]: [...batch, change] }));
      setNotice(`Added ${draft.path} to the proposal batch.`);
    });
  }

  function stageEditBatch(project: Project) {
    return run(async () => {
      const batch = editBatch[project.id] ?? [];
      if (batch.length === 0) throw new Error("Add at least one file change to the batch");
      const result = await window.nexus.edits.propose(project.id, editTitle.trim() || `Edit ${batch.length} file(s)`, batch) as EditProposal;
      const list = await window.nexus.edits.list(project.id) as EditProposalList;
      setEditProposals((current) => ({ ...current, [project.id]: list.proposals }));
      setSelectedEdits((current) => ({ ...current, [project.id]: result }));
      setEditBatch((current) => ({ ...current, [project.id]: [] }));
      setNotice(`Prepared a ${batch.length}-file proposal. Review its diffs before applying.`);
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
      await window.nexus.edits.apply(project.id, proposal.id, true);
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

              <section className="task-panel">
                <h3>Terminal</h3>
                <p className="muted small">Run a command in this project. Every run requires confirmation and is limited to two minutes and 128 KiB of output.</p>
                <div className="task-form">
                  <select value={terminalShell} onChange={(event) => setTerminalShell(event.target.value as typeof terminalShell)} aria-label="Command shell">
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">Command Prompt</option>
                  </select>
                  <input value={terminalCwd} onChange={(event) => setTerminalCwd(event.target.value)} maxLength={4096}
                    placeholder="Working directory inside project (optional)" aria-label="Project-relative working directory" />
                  <textarea value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} maxLength={16000}
                    placeholder="Enter command" aria-label="Terminal command" />
                  <div className="actions">
                    <button className="secondary-button" onClick={() => void runTerminal(project)} disabled={busy || !terminalCommand.trim()}>Review and run</button>
                    <button className="text-button" onClick={() => void loadTerminalProcesses(project)} disabled={busy}>Owned processes</button>
                  </div>
                </div>
                {terminalResults[project.id] && (
                  <>
                  <p className="muted small">Process {terminalResults[project.id].processId} · {terminalResults[project.id].status.toUpperCase()}{terminalResults[project.id].exitCode !== null ? ` · exit ${terminalResults[project.id].exitCode}` : ""}</p>
                  <pre className="diff-view" aria-live="polite">{terminalResults[project.id].stdout}{terminalResults[project.id].stderr ? `\n${terminalResults[project.id].stderr}` : ""}
                    {terminalResults[project.id].outputTruncated ? "\n… output truncated at 128 KiB" : ""}
                    {terminalResults[project.id].timedOut ? "\n… command timed out" : ""}
                  </pre>
                  </>
                )}
                {(terminalProcesses[project.id] ?? []).map((process) => (
                  <div className="snapshot-row" key={process.processId}>
                    <code>{process.processId}</code>
                    <button className="text-button" onClick={() => void stopTerminalProcess(project, process.processId)} disabled={busy}>Stop</button>
                  </div>
                ))}
              </section>

                            <section className="task-panel">
                <h3>Isolated browser</h3>
                <p className="muted small">Headless Chromium with bounded text snapshots. Navigation, clicks, form fills, and closing require confirmation; page text is untrusted.</p>
                <div className="task-form">
                  <div className="search-row">
                    <input value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} maxLength={4096}
                      placeholder="https://example.com" aria-label="Browser URL" />
                    {!browserByProject[project.id] ?
                      <button className="secondary-button" onClick={() => void startBrowser(project)} disabled={busy}>Start browser</button> :
                      <button className="secondary-button" onClick={() => void navigateBrowser(project)} disabled={busy}>Review and navigate</button>}
                  </div>
                  {browserByProject[project.id] && (
                    <>
                      <p className="muted small">Session {browserByProject[project.id].sessionId} · {browserByProject[project.id].url || "about:blank"}</p>
                      <div className="search-row">
                        <input value={browserSelector} onChange={(event) => setBrowserSelector(event.target.value)} maxLength={2000}
                          placeholder="CSS selector, e.g. input[name=email]" aria-label="Browser element selector" />
                        <button className="text-button" onClick={() => void clickBrowser(project)} disabled={busy || !browserSelector.trim()}>Confirm click</button>
                      </div>
                      <div className="search-row">
                        <input value={browserValue} onChange={(event) => setBrowserValue(event.target.value)} maxLength={2000}
                          placeholder="Text to fill" aria-label="Text to fill in browser" />
                        <button className="text-button" onClick={() => void fillBrowser(project)} disabled={busy || !browserSelector.trim()}>Confirm fill</button>
                      </div>
                      <div className="actions">
                        <button className="text-button" onClick={() => void refreshBrowser(project)} disabled={busy}>Refresh page text</button>
                        <button className="text-button" onClick={() => void closeBrowser(project)} disabled={busy}>Close session</button>
                      </div>
                      <section className="source-result" aria-live="polite">
                        <strong>{browserByProject[project.id].title || "Page snapshot"}</strong>
                        <pre>{browserByProject[project.id].text || "(No visible page text)"}{browserByProject[project.id].truncated ? "\n… page text truncated at 12,000 characters" : ""}</pre>
                      </section>
                    </>
                  )}
                </div>
              </section>

<section className="task-panel">
                <div className="project-heading">
                  <div>
                    <h3>Task planner</h3>
                    <p className="muted small">Save a dependency-aware plan and track each step. Execution is manual until the background agent engine is implemented.</p>
                  </div>
                  <button className="text-button" onClick={() => void loadTasks(project)} disabled={busy}>Task history</button>
                </div>
                <div className="task-form">
                  <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)}
                    maxLength={160} placeholder="Task title" aria-label="Task title" />
                  <textarea value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)}
                    maxLength={4000} placeholder="Describe the intended outcome" aria-label="Task description" />
                  <textarea value={taskPlan} onChange={(event) => setTaskPlan(event.target.value)}
                    placeholder={"One plan step per line\nInspect existing code\nImplement the change\nVerify the result"} aria-label="Task plan steps" />
                  <div className="actions">
                    <select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as typeof taskPriority)} aria-label="Task priority">
                      <option value="low">Low priority</option>
                      <option value="normal">Normal priority</option>
                      <option value="high">High priority</option>
                    </select>
                    <button className="secondary-button" onClick={() => void createPlannedTask(project)} disabled={busy || !taskTitle.trim()}>Save plan</button>
                  </div>
                </div>
                {(tasksByProject[project.id] ?? []).map((task) => (
                  <article className="task-card" key={task.id}>
                    <div className="project-heading">
                      <strong>{task.title}</strong>
                      <span className="index-badge">{task.status.toUpperCase()} · {task.progress}%</span>
                    </div>
                    <p className="muted small">{task.priority.toUpperCase()} PRIORITY · {task.description}</p>
                    <progress value={task.progress} max="100" aria-label="Task progress" />
                    <ol className="task-steps">
                      {task.steps.map((step) => (
                        <li key={step.id}>
                          <span>{step.title} · {step.status}{step.dependencies.length ? " · depends on earlier steps" : ""}</span>
                          {step.description && <small className="muted">{step.description}</small>}
                          {task.status === "running" && step.status === "pending" &&
                            <button className="text-button" onClick={() => void run(() => updateTaskStep(project, task, step, "running"))} disabled={busy}>Start</button>}
                          {task.status === "running" && step.status === "running" &&
                            <button className="text-button" onClick={() => void run(() => updateTaskStep(project, task, step, "completed"))} disabled={busy}>Complete</button>}
                        </li>
                      ))}
                    </ol>
                    <div className="actions">
                      {task.status === "pending" && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "planning"))} disabled={busy}>Start planning</button>}
                      {task.status === "planning" && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "awaiting_approval"))} disabled={busy}>Request approval</button>}
                      {task.status === "awaiting_approval" && <button className="secondary-button" onClick={() => void run(() => updateTask(project, task, "running"))} disabled={busy}>Approve and run</button>}
                      {task.status === "running" && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "paused"))} disabled={busy}>Pause</button>}
                      {(task.status === "paused" || task.status === "failed") && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "running"))} disabled={busy}>Resume</button>}
                      {task.status === "running" && task.progress === 100 && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "completed"))} disabled={busy}>Mark complete</button>}
                      {!["completed", "cancelled"].includes(task.status) && <button className="text-button" onClick={() => void run(() => updateTask(project, task, "cancelled"))} disabled={busy}>Cancel</button>}
                    </div>
                    <details className="task-events">
                      <summary>Execution history ({task.events.length})</summary>
                      <ul>{task.events.slice(-10).reverse().map((event) => (
                        <li key={event.id}><time>{new Date(event.at).toLocaleString()}</time> · {event.message}</li>
                      ))}</ul>
                    </details>
                    {task.error && <p className="message error">{task.error}</p>}
                  </article>
                ))}
              </section>

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
                      <button className="secondary-button" onClick={() => void queueEditChange(project, "write")} disabled={busy}>Add change</button>
                      {drafts[project.id].exists && (
                        <>
                          <button className="text-button" onClick={() => void queueEditChange(project, "delete")} disabled={busy}>Add delete</button>
                          <input value={moveDestination} onChange={(event) => setMoveDestination(event.target.value)}
                            maxLength={4096} placeholder="New project-relative path" aria-label="Move destination" />
                          <button className="text-button" onClick={() => void queueEditChange(project, "move")} disabled={busy}>Add move</button>
                        </>
                      )}
                      <button className="text-button" onClick={() => void loadEditProposals(project)} disabled={busy}>Edit history</button>
                    </div>
                    {(editBatch[project.id] ?? []).length > 0 && (
                      <div className="edit-batch">
                        <p className="muted small">Queued {editBatch[project.id].length} file change(s): {editBatch[project.id].map((change) => change.path).join(", ")}</p>
                        <button className="primary-button" onClick={() => void stageEditBatch(project)} disabled={busy}>
                          Review {editBatch[project.id].length}-file proposal
                        </button>
                      </div>
                    )}
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
                        <div className="source-heading"><strong>{change.path}{change.destinationPath ? ` → ${change.destinationPath}` : ""} · {change.action}</strong>
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
