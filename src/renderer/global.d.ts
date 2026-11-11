export {};

declare global {
  interface Window {
    nexus: {
      projects: {
        choose(): Promise<unknown>;
        list(): Promise<unknown>;
        scan(id: string): Promise<unknown>;
        remove(id: string): Promise<boolean>;
      };
    };
  }
}
