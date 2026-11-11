import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  clickBrowserElement,
  closeBrowserSession,
  fillBrowserElement,
  navigateBrowser,
  readBrowserSnapshot,
  startBrowserSession,
  type BrowserSnapshot
} from "./browser-service.js";

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Browser input must be an object");
  return input as Record<string, unknown>;
}

function projectInput(input: unknown): { projectId: string } {
  const value = record(input);
  if (typeof value.projectId !== "string") throw new Error("Project identifier is required");
  return { projectId: value.projectId };
}

function sessionInput(input: unknown): { projectId: string; sessionId: string } {
  const value = record(input);
  if (typeof value.projectId !== "string" || typeof value.sessionId !== "string") {
    throw new Error("Project and browser session identifiers are required");
  }
  return { projectId: value.projectId, sessionId: value.sessionId };
}

export function registerBrowserTools(registry: ToolRegistry): void {
  registry.register({
    id: "browser.start",
    name: "Start isolated browser",
    description: "Launch a headless Chromium session isolated to one project",
    risk: "high",
    timeoutMs: 20_000,
    validate: projectInput,
    execute: (input) => startBrowserSession(input.projectId)
  });
  registry.register({
    id: "browser.navigate",
    name: "Navigate browser",
    description: "Navigate an approved session to an http or https URL",
    risk: "high",
    timeoutMs: 20_000,
    validate(input) {
      const value = record(input);
      if (typeof value.projectId !== "string" || typeof value.sessionId !== "string" || typeof value.url !== "string") {
        throw new Error("Project, session, and URL are required");
      }
      return { projectId: value.projectId, sessionId: value.sessionId, url: value.url };
    },
    execute: (input) => navigateBrowser(input.projectId, input.sessionId, input.url)
  });
  registry.register({
    id: "browser.snapshot",
    name: "Read page snapshot",
    description: "Read bounded visible text and title from the current browser page",
    risk: "low",
    timeoutMs: 10_000,
    validate: sessionInput,
    execute: (input): Promise<BrowserSnapshot> => readBrowserSnapshot(input.projectId, input.sessionId)
  });
  registry.register({
    id: "browser.click",
    name: "Click page element",
    description: "Click the first element matching a reviewed selector",
    risk: "high",
    timeoutMs: 15_000,
    validate(input) {
      const value = record(input);
      if (typeof value.projectId !== "string" || typeof value.sessionId !== "string" ||
          typeof value.selector !== "string") throw new Error("Project, session, and selector are required");
      return { projectId: value.projectId, sessionId: value.sessionId, selector: value.selector };
    },
    execute: (input) => clickBrowserElement(input.projectId, input.sessionId, input.selector)
  });
  registry.register({
    id: "browser.fill",
    name: "Fill page field",
    description: "Fill the first form field matching a reviewed selector",
    risk: "high",
    timeoutMs: 15_000,
    validate(input) {
      const value = record(input);
      if (typeof value.projectId !== "string" || typeof value.sessionId !== "string" ||
          typeof value.selector !== "string" || typeof value.value !== "string") {
        throw new Error("Project, session, selector, and text value are required");
      }
      return { projectId: value.projectId, sessionId: value.sessionId, selector: value.selector, value: value.value };
    },
    execute: (input) => fillBrowserElement(input.projectId, input.sessionId, input.selector, input.value)
  });
  registry.register({
    id: "browser.close",
    name: "Close browser session",
    description: "Close the browser session owned by this project",
    risk: "medium",
    timeoutMs: 10_000,
    validate: sessionInput,
    execute: (input) => closeBrowserSession(input.projectId, input.sessionId)
  });
}
