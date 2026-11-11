import { createServer } from "node:http";
import { createApiApp } from "./app.js";
import { stopProjectWatchers, watchProjects } from "../project-intelligence/watcher.js";
import { projectStore } from "../storage/project-store.js";

export interface RunningApi {
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(apiToken: string, port = 0): Promise<RunningApi> {
  const projects = await projectStore.list();
  watchProjects(projects);

  const server = createServer(createApiApp(apiToken));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    stopProjectWatchers();
    await projectStore.close();
    throw new Error("Could not determine the API server port");
  }

  return {
    port: address.port,
    close: async () => {
      stopProjectWatchers();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await projectStore.close();
    }
  };
}
