export {};

declare global {
  interface Window {
    nexus: {
      projects: {
        choose(): Promise<unknown>;
        list(): Promise<unknown>;
        scan(id: string): Promise<unknown>;
        searchContext(id: string, query: string): Promise<unknown>;
        remove(id: string): Promise<boolean>;
      };
      snapshots: {
        list(projectId: string, filePath?: string): Promise<unknown>;
        create(projectId: string, filePath: string, reason?: string): Promise<unknown>;
        diff(projectId: string, snapshotId: string): Promise<unknown>;
        restore(projectId: string, snapshotId: string, expectedCurrentHash: string | null): Promise<unknown>;
      };
      files: {
        read(projectId: string, filePath: string): Promise<unknown>;
      };
      edits: {
        list(projectId: string): Promise<unknown>;
        propose(projectId: string, title: string, changes: unknown[]): Promise<unknown>;
        get(projectId: string, proposalId: string): Promise<unknown>;
        apply(projectId: string, proposalId: string, approvalGranted: boolean): Promise<unknown>;
        reject(projectId: string, proposalId: string): Promise<boolean>;
      };
      terminal: {
        run(projectId: string, input: unknown, approvalGranted: boolean): Promise<unknown>;
        listProcesses(projectId: string): Promise<unknown>;
        getProcess(projectId: string, processId: string): Promise<unknown>;
        cancel(projectId: string, processId: string, approvalGranted: boolean): Promise<unknown>;
      };
      browser: {
        start(projectId: string, approvalGranted: boolean): Promise<unknown>;
        navigate(projectId: string, sessionId: string, url: string, approvalGranted: boolean): Promise<unknown>;
        snapshot(projectId: string, sessionId: string): Promise<unknown>;
        click(projectId: string, sessionId: string, selector: string, approvalGranted: boolean): Promise<unknown>;
        fill(projectId: string, sessionId: string, selector: string, value: string, approvalGranted: boolean): Promise<unknown>;
        close(projectId: string, sessionId: string, approvalGranted: boolean): Promise<unknown>;
      };
      tasks: {
        list(projectId: string): Promise<unknown>;
        create(projectId: string, input: unknown): Promise<unknown>;
        setStatus(projectId: string, taskId: string, status: string, note?: string): Promise<unknown>;
        setStep(projectId: string, taskId: string, stepId: string, status: string, result?: string): Promise<unknown>;
      };
    };
  }
}
