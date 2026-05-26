import express from "express";
import type { Server } from "node:http";
import { detectHumanLoopRequest } from "./human-loop.js";
import { buildProgressStreamContent, collapseProgressUpdates } from "./progress-updates.js";
import { filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";

const DEFAULT_DIAGNOSTIC_PORT = 3010;

type EvaluateCase = "progress" | "tool-context" | "human-loop";

type DiagnosticResult =
  | { case: "progress"; collapsed: string; streamContent: string }
  | { case: "tool-context"; filteredContent: string }
  | { case: "human-loop"; request: ReturnType<typeof detectHumanLoopRequest> };

export function evaluateDiagnosticCase(caseName: "progress", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "progress" }>;
export function evaluateDiagnosticCase(caseName: "tool-context", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "tool-context" }>;
export function evaluateDiagnosticCase(caseName: "human-loop", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "human-loop" }>;
export function evaluateDiagnosticCase(caseName: EvaluateCase, input: Record<string, unknown>): DiagnosticResult;
export function evaluateDiagnosticCase(caseName: EvaluateCase, input: Record<string, unknown>): DiagnosticResult {
  if (caseName === "progress") {
    const content = String(input.content || "");
    const activeCall = input.activeCall ? String(input.activeCall) : "";
    const activeCalls = activeCall ? [activeCall] : [];
    return {
      case: caseName,
      collapsed: collapseProgressUpdates(content),
      streamContent: buildProgressStreamContent(content, activeCalls),
    };
  }

  if (caseName === "tool-context") {
    const record: ToolContextRecord = {
      id: String(input.id || "diagnostic-tool-call"),
      name: String(input.name || "query"),
      args: String(input.args || "{}"),
      content: String(input.content || ""),
    };
    return {
      case: caseName,
      filteredContent: filterToolResultForCurrentTurn(record),
    };
  }

  if (caseName === "human-loop") {
    const content = String(input.content || "");
    return {
      case: caseName,
      request: detectHumanLoopRequest(content),
    };
  }

  throw new Error(`Unsupported diagnostic case: ${caseName}`);
}

function normalizeCase(value: unknown): EvaluateCase {
  if (value === "progress" || value === "tool-context" || value === "human-loop") {
    return value;
  }
  throw new Error("case must be one of: progress, tool-context, human-loop");
}

export function startDiagnosticServer() {
  if (process.env.DIAGNOSTIC_ENABLED === "false") {
    return;
  }

  const port = Number(process.env.DIAGNOSTIC_PORT || DEFAULT_DIAGNOSTIC_PORT);
  const host = process.env.DIAGNOSTIC_HOST || "0.0.0.0";
  const app = express();

  app.use(express.json({ limit: "256kb" }));

  app.get("/__debug/status", (_req, res) => {
    res.json({
      ok: true,
      service: "wecom-agent",
      diagnostics: {
        enabled: true,
        port,
      },
      cases: ["progress", "tool-context", "human-loop"],
    });
  });

  app.get("/__debug/evaluate", (req, res) => {
    try {
      res.json(evaluateDiagnosticCase(normalizeCase(req.query.case), req.query));
    } catch (error: any) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/__debug/evaluate", (req, res) => {
    try {
      res.json(evaluateDiagnosticCase(normalizeCase(req.body?.case), req.body || {}));
    } catch (error: any) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  return app.listen(port, host, () => {
    console.log(`[diagnostic] Listening on ${host}:${port}`);
  });
}

export function stopDiagnosticServer(server: Server | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
