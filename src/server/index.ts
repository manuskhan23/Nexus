import express from "express";
import { scanProject } from "../project-intelligence/scanner.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "nexus-api", phase: 1 });
});

app.post("/api/projects/scan", async (request, response) => {
  const projectPath: unknown = request.body?.path;
  if (typeof projectPath !== "string" || projectPath.trim().length === 0 || projectPath.length > 4096) {
    response.status(400).json({ error: "A valid project path is required" });
    return;
  }
  try {
    const scan = await scanProject(projectPath);
    response.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project scan failed";
    response.status(400).json({ error: message });
  }
});

const port = Number(process.env.NEXUS_API_PORT ?? 3001);
app.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "server.started", port, host: "127.0.0.1" }));
});
