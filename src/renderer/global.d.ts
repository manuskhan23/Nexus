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
        apply(projectId: string, proposalId: string): Promise<unknown>;
        reject(projectId: string, proposalId: string): Promise<boolean>;
      };
    };
  }
}
