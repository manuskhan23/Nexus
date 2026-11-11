import { startApiServer, type RunningApi } from "./runtime.js";

function requireApiToken(): string {
  const token = process.env.NEXUS_API_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("Set NEXUS_API_TOKEN to a random value of at least 32 characters");
  }
  return token;
}

const apiToken = requireApiToken();
let running: RunningApi | undefined;

async function start(): Promise<void> {
  running = await startApiServer(apiToken, Number(process.env.NEXUS_API_PORT ?? 3001));
  console.log(JSON.stringify({ event: "server.started", port: running.port, host: "127.0.0.1" }));
}

async function shutdown(): Promise<void> {
  await running?.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

start().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: "server.start_failed",
    message: error instanceof Error ? error.message : "API startup failed"
  }));
  process.exitCode = 1;
});
