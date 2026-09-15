import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { Type, type Message, type TSchema } from "@earendil-works/pi-ai";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "./config.js";
import { stringifyModelContent } from "./model-content.js";
import { redactSensitiveValues } from "./request-raw-trace.js";
import { isToolResultFileReadTool } from "./tool-result-store.js";
import { compressPiToolResult, serializePiToolResult } from "./pi-tool-result-compressor.js";

export type PiAgentEvent = AgentEvent;

export type PiRuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; args: unknown; result: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "agent_end" }
  | { type: "error"; message: string }
  | { type: "aborted" };

export interface PiAgentRuntimeOptions {
  prompt: string;
  systemPrompt: string;
  tools?: any[];
  signal?: AbortSignal;
  deadlineMs?: number;
  toolTimeoutMs?: number;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  budget?: PiRunBudgetNote;
  onEvent?: (event: PiAgentEvent) => void | Promise<void>;
}

export interface PiAgentStreamInput {
  messages: BaseMessage[];
}

export interface PiAgentFacade {
  stream(
    input: PiAgentStreamInput,
    options?: { signal?: AbortSignal; deadlineMs?: number; recursionLimit?: number; streamMode?: string },
  ): AsyncGenerator<[BaseMessage, Record<string, unknown>]>;
  streamPiEvents(
    prompt: string,
    options?: { signal?: AbortSignal; deadlineMs?: number },
    contextMessages?: BaseMessage[],
  ): AsyncGenerator<PiAgentEvent>;
  abort(): void;
  waitForIdle(): Promise<void>;
}

function toPiParameters(tool: any): TSchema {
  const schema = tool?.schema || tool?.input_schema || tool?.inputSchema;
  if (schema && typeof (z as any).toJSONSchema === "function") {
    try {
      return (z as any).toJSONSchema(schema) as TSchema;
    } catch {
      // 非 Zod schema 继续使用 MCP 原始 JSON schema。
    }
  }
  if (schema && typeof schema === "object" && (schema.type || schema.properties)) {
    return schema as TSchema;
  }
  return Type.Object({});
}

function explicitToolErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const result = value as { isError?: unknown; status?: unknown; message?: unknown; error?: unknown; content?: unknown };
  if (
    result.isError !== true
    && result.status !== "error"
    && result.error !== "MCP_CONFIG_SCOPE_VIOLATION"
  ) return null;
  const detail = redactSensitiveValues(stringifyModelContent(
    result.message ?? result.error ?? result.content,
  )).slice(0, 1_000);
  return detail ? `Pi 工具返回错误：${detail}` : "Pi 工具返回错误";
}

function safeToolErrorMessage(error: unknown) {
  let message = "";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) || "";
    } catch {
      message = String(error);
    }
  }
  const detail = redactSensitiveValues(message).replace(/\s+/gu, " ").slice(0, 1_000);
  return detail ? `Pi 工具执行失败：${detail}` : "Pi 工具执行失败";
}

function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 0,
  onTimeout?: () => void,
): Promise<T> {
  void promise.catch(() => undefined);
  if (!signal && timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abort = () => {
      if (timedOut) return;
      if (timer) clearTimeout(timer);
      reject(new Error("Pi 工具执行已取消"));
    };
    const timeout = () => {
      timedOut = true;
      reject(new Error(`Pi 工具执行超时（${timeoutMs}ms）`));
      onTimeout?.();
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(timeout, timeoutMs);
    }
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

export function filterPiAgentTools(tools: any[]) {
  return tools.filter(tool => tool?.name !== "runtime_todolist_update");
}

/** 运行期时间预算注记：工具执行时实时计算剩余时间，供模型决定是否继续检索。 */
export type PiRunBudgetNote = () => string;

const PI_WRAP_UP_REMAINING_SECONDS = 90;

export function formatPiBudgetNote(startedAt: number, deadlineMs: number, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const limitSeconds = Math.max(1, Math.round(deadlineMs / 1000));
  const remainingSeconds = Math.max(0, limitSeconds - elapsedSeconds);
  const base = `[时间预算] 已用 ${elapsedSeconds}s / 上限 ${limitSeconds}s，剩余 ${remainingSeconds}s`;
  return remainingSeconds <= PI_WRAP_UP_REMAINING_SECONDS
    ? `${base}。剩余时间不足，必须立即用现有证据给出最终结论，不要再发起新的检索。`
    : `${base}。请据此判断是否继续检索。`;
}

/** 将现有 MCP 工具注册为 Pi AgentTool，保留工具的 invoke 契约。 */
export function createPiMcpPluginTools(
  tools: any[],
  options: PiMcpPluginOptions = {},
): AgentTool[] {
  return tools
    .filter(tool => typeof tool?.invoke === "function" && typeof tool?.name === "string")
    .map(tool => ({
      name: tool.name,
      label: tool.name,
      description: String(tool.description || tool.name),
      parameters: toPiParameters(tool),
      executionMode: "sequential" as const,
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const effectiveSignal = signal || options.signal;
        if (effectiveSignal?.aborted) throw new Error("Pi 工具执行已取消");
        const controller = new AbortController();
        const relayAbort = () => controller.abort();
        if (effectiveSignal?.aborted) controller.abort();
        else effectiveSignal?.addEventListener("abort", relayAbort, { once: true });
        let result: unknown;
        try {
          result = await withAbort(
            Promise.resolve().then(() => {
              if (controller.signal.aborted) throw new Error("Pi 工具执行已取消");
              return tool.invoke(params, { signal: controller.signal, toolCallId });
            }),
            controller.signal,
            options.toolTimeoutMs,
            relayAbort,
          ).finally(() => effectiveSignal?.removeEventListener("abort", relayAbort));
        } catch (error) {
          throw new Error(safeToolErrorMessage(error));
        }
        const explicitError = explicitToolErrorMessage(result);
        if (explicitError) throw new Error(explicitError);
        const content = isToolResultFileReadTool(tool)
          ? serializePiToolResult(result)
          : compressPiToolResult(tool.name, result, params);
        const budgetNote = options.budget?.().trim();
        const text = budgetNote ? `${content}\n\n${budgetNote}` : content;
        return {
          content: [{ type: "text" as const, text }],
          details: { toolCallId },
        };
      },
    }));
}

export interface PiMcpPluginOptions {
  toolTimeoutMs?: number;
  signal?: AbortSignal;
  budget?: PiRunBudgetNote | undefined;
}

function createPiModel(modelName: string, baseUrl: string) {
  return {
    id: modelName,
    name: modelName,
    api: "openai-completions" as const,
    provider: "wecom-agent",
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: 0,
    ...(config.llm.maxOutputTokens
      ? { maxTokens: config.llm.maxOutputTokens }
      : { maxTokens: 32768 }),
    compat: { supportsUsageInStreaming: true, supportsStrictMode: false },
  };
}

export function createPiAgent(options: Omit<PiAgentRuntimeOptions, "prompt" | "signal" | "deadlineMs" | "onEvent">) {
  const modelName = options.model || config.llm.modelName;
  const baseUrl = options.baseUrl || config.llm.baseUrl;
  const tools = createPiMcpPluginTools(options.tools || [], {
    toolTimeoutMs: options.toolTimeoutMs || config.llm.toolTimeoutMs,
    budget: options.budget,
  });

  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: createPiModel(modelName, baseUrl),
      tools,
    },
    streamFn: streamSimple as StreamFn,
    getApiKey: () => options.apiKey || config.llm.apiKey,
    toolExecution: "sequential",
  });
}

function latestPrompt(messages: BaseMessage[]) {
  const message = [...messages].reverse().find(item => item instanceof HumanMessage || item._getType?.() === "human");
  return message ? stringifyModelContent(message.content) : "";
}

function removePromptMessage(messages: BaseMessage[], prompt: string) {
  const index = [...messages].reverse().findIndex(message =>
    (message instanceof HumanMessage || message._getType?.() === "human")
    && stringifyModelContent(message.content) === prompt,
  );
  if (index < 0) return messages;
  const actualIndex = messages.length - 1 - index;
  return messages.filter((_message, messageIndex) => messageIndex !== actualIndex);
}

function toPiMessages(messages: BaseMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const content = stringifyModelContent(message.content);
    const type = message._getType?.() || "";
    if (type === "human") {
      converted.push({ role: "user", content, timestamp: Date.now() });
    } else if (type === "ai") {
      converted.push({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-completions",
        provider: "wecom-agent",
        model: config.llm.modelName,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    } else if (type === "tool") {
      const toolMessage = message as ToolMessage;
      converted.push({
        role: "toolResult",
        toolCallId: String(toolMessage.tool_call_id || "history-tool"),
        toolName: String(toolMessage.name || "unknown_tool"),
        content: [{ type: "text", text: content }],
        details: {},
        isError: toolMessage.status === "error",
        timestamp: Date.now(),
      });
    }
  }
  return converted;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") return "";
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(item => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map(item => stringifyModelContent((item as { text?: unknown }).text))
    .filter(Boolean)
    .join("\n");
}

export interface PiContentBlockSummary {
  count: number;
  blocks: Array<{ type: string; length: number }>;
  textLength: number;
}

export function summarizeContentBlocks(content: unknown): PiContentBlockSummary {
  if (!Array.isArray(content)) {
    return { count: 0, blocks: [], textLength: 0 };
  }

  const blocks = content.map(item => {
    if (!item || typeof item !== "object") {
      return { type: typeof item, length: 0 };
    }
    const block = item as { type?: unknown; text?: unknown; thinking?: unknown };
    const type = typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";
    const length = type === "text" && typeof block.text === "string"
      ? block.text.length
      : type === "thinking" && typeof block.thinking === "string"
        ? block.thinking.length
        : 0;
    return { type, length };
  });

  return {
    count: blocks.length,
    blocks,
    textLength: blocks
      .filter(block => block.type === "text")
      .reduce((total, block) => total + block.length, 0),
  };
}

export function sanitizeLifecycleError(value: unknown): string | null {
  let message: string;
  if (value instanceof Error) {
    message = value.message;
  } else if (typeof value === "string") {
    message = value;
  } else if (value == null) {
    return null;
  } else if (typeof value === "number" || typeof value === "boolean") {
    message = String(value);
  } else {
    return null;
  }

  const normalized = redactSensitiveValues(message).replace(/\s+/gu, " ").slice(0, 160);
  return normalized || null;
}

function normalizeLifecycleReason(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  return /^[A-Za-z0-9_.-]{1,32}$/u.test(normalized) ? normalized : "unknown";
}

export function formatPiLifecycleLog(record: Record<string, unknown>): string {
  try {
    return `[Pi lifecycle] ${JSON.stringify(record)}`;
  } catch {
    return `[Pi lifecycle] ${JSON.stringify({ event: "log_error" })}`;
  }
}

function eventToMessage(event: PiAgentEvent): BaseMessage | null {
  if (event.type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const lastAssistant = messages[messages.length - 1] as {
      role?: string;
      content?: unknown;
      stopReason?: unknown;
    } | undefined;
    if (!lastAssistant || lastAssistant.role !== "assistant" || lastAssistant.stopReason !== "stop") return null;
    const content = extractAssistantText(lastAssistant);
    return content ? new AIMessage(content) : null;
  }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return new AIMessage(event.assistantMessageEvent.delta);
  }
  if (event.type === "tool_execution_start") {
    return new AIMessage({
      content: "",
      tool_calls: [{ id: event.toolCallId, name: event.toolName, args: event.args }],
    });
  }
  if (event.type === "tool_execution_end") {
    const content = event.result?.content || event.result;
    return new ToolMessage({
      content: stringifyModelContent(content),
      tool_call_id: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "error" : "success",
    });
  }
  return null;
}

export function createPiAgentFacade(
  options: Omit<PiAgentRuntimeOptions, "prompt" | "signal" | "deadlineMs" | "onEvent">,
): PiAgentFacade {
  let budgetNote: PiRunBudgetNote = () => "";
  const agent = createPiAgent({ ...options, budget: () => budgetNote() });
  let activeAbort: (() => void) | undefined;
  return {
    async *streamPiEvents(prompt, streamOptions: { signal?: AbortSignal; deadlineMs?: number } = {}, contextMessages: BaseMessage[] = []) {
      const queue: PiAgentEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      let agentEnded = false;
      let promptRejected = false;
      let cancelRequested = false;
      let disposed = false;
      let turnCount = 0;
      const push = (event: PiAgentEvent) => {
        if (disposed) return;
        if (event.type === "turn_start") {
          turnCount += 1;
          console.log(formatPiLifecycleLog({ event: "turn_start", turn: turnCount }));
        }
        if (event.type === "turn_end") {
          const message = event.message as {
            content?: unknown;
            stopReason?: unknown;
            rawStopReason?: unknown;
            errorMessage?: unknown;
          };
          console.log(formatPiLifecycleLog({
            event: "turn_end",
            turn: turnCount,
            toolResults: event.toolResults.length,
            stopReason: normalizeLifecycleReason(message.stopReason),
            rawStopReason: normalizeLifecycleReason(message.rawStopReason),
            content: summarizeContentBlocks(message.content),
            errorMessage: sanitizeLifecycleError(message.errorMessage),
          }));
        }
        if (event.type === "agent_end") {
          agentEnded = true;
          const finalText = extractAssistantText(event.messages[event.messages.length - 1]);
          console.log(formatPiLifecycleLog({
            event: "agent_end",
            turns: turnCount,
            messages: event.messages.length,
            finalTextLength: finalText.length,
          }));
        }
        queue.push(event);
        if (event.type === "agent_end") {
          agentEnded = true;
          ended = true;
        }
        wake?.();
        wake = undefined;
      };
      const unsubscribe = agent.subscribe(push);
      const abort = () => {
        cancelRequested = true;
        ended = true;
        wake?.();
        wake = undefined;
        agent.abort();
      };
      activeAbort = abort;
      if (streamOptions.signal?.aborted) abort();
      else streamOptions.signal?.addEventListener("abort", abort, { once: true });
      const deadlineMs = streamOptions.deadlineMs ?? config.llm.requestTimeoutMs;
      const runStartedAt = Date.now();
      budgetNote = () => formatPiBudgetNote(runStartedAt, deadlineMs);
      const timer = deadlineMs > 0
        ? setTimeout(abort, deadlineMs)
        : undefined;
      agent.state.messages = toPiMessages(removePromptMessage(contextMessages, prompt));
      const promptPromise = (streamOptions.signal?.aborted
        ? Promise.reject(new Error("Pi Agent 执行已取消"))
        : Promise.resolve().then(() => {
          if (cancelRequested || streamOptions.signal?.aborted) {
            throw new Error("Pi Agent 执行已取消");
          }
          return agent.prompt(prompt);
        })
      ).catch(error => {
        promptRejected = true;
        ended = true;
        wake?.();
        wake = undefined;
        throw error;
      });
      void promptPromise.catch(() => undefined);
      try {
        while (!ended || queue.length > 0) {
          if (queue.length === 0) {
            if (ended) break;
            await new Promise<void>(resolve => { wake = resolve; });
            continue;
          }
          yield queue.shift()!;
        }
        await promptPromise;
      } finally {
        disposed = true;
        if (cancelRequested || !agentEnded || promptRejected) agent.abort();
        if (timer) clearTimeout(timer);
        streamOptions.signal?.removeEventListener("abort", abort);
        unsubscribe();
        if (activeAbort === abort) activeAbort = undefined;
        await agent.waitForIdle();
      }
    },
    async *stream(input, streamOptions: { signal?: AbortSignal; deadlineMs?: number; recursionLimit?: number; streamMode?: string } = {}) {
      const queue: Array<[BaseMessage, Record<string, unknown>]> = [];
      let wake: (() => void) | undefined;
      let ended = false;
      let agentEnded = false;
      let promptRejected = false;
      let cancelRequested = false;
      let disposed = false;
      let turnCount = 0;
      const push = (event: PiAgentEvent) => {
        if (disposed) return;
        if (event.type === "turn_start") {
          turnCount += 1;
          console.log(formatPiLifecycleLog({ event: "turn_start", turn: turnCount }));
        }
        if (event.type === "turn_end") {
          const message = event.message as {
            content?: unknown;
            stopReason?: unknown;
            rawStopReason?: unknown;
            errorMessage?: unknown;
          };
          console.log(formatPiLifecycleLog({
            event: "turn_end",
            turn: turnCount,
            toolResults: event.toolResults.length,
            stopReason: normalizeLifecycleReason(message.stopReason),
            rawStopReason: normalizeLifecycleReason(message.rawStopReason),
            content: summarizeContentBlocks(message.content),
            errorMessage: sanitizeLifecycleError(message.errorMessage),
          }));
        }
        if (event.type === "agent_end") {
          agentEnded = true;
          const finalText = extractAssistantText(event.messages[event.messages.length - 1]);
          console.log(formatPiLifecycleLog({
            event: "agent_end",
            turns: turnCount,
            messages: event.messages.length,
            finalTextLength: finalText.length,
          }));
          ended = true;
          wake?.();
          wake = undefined;
        }
        const message = eventToMessage(event);
        if (message) {
          queue.push([message, {}]);
          wake?.();
          wake = undefined;
        }
      };
      const unsubscribe = agent.subscribe(push);
      const abort = () => {
        cancelRequested = true;
        ended = true;
        wake?.();
        wake = undefined;
        agent.abort();
      };
      activeAbort = abort;
      agent.state.messages = toPiMessages(removePromptMessage(input.messages, latestPrompt(input.messages)));
      const promptPromise = (streamOptions.signal?.aborted
        ? Promise.reject(new Error("Pi Agent 执行已取消"))
        : Promise.resolve().then(() => {
          if (cancelRequested || streamOptions.signal?.aborted) {
            throw new Error("Pi Agent 执行已取消");
          }
          return agent.prompt(latestPrompt(input.messages));
        })
      ).catch(error => {
        promptRejected = true;
        ended = true;
        wake?.();
        wake = undefined;
        throw error;
      });
      void promptPromise.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (streamOptions.signal) {
        if (streamOptions.signal.aborted) abort();
        else streamOptions.signal.addEventListener("abort", abort, { once: true });
      }
      const deadlineMs = streamOptions.deadlineMs ?? config.llm.requestTimeoutMs;
      if (deadlineMs > 0) {
        timer = setTimeout(abort, deadlineMs);
      }
      try {
        while (!ended || queue.length > 0) {
          if (queue.length === 0) {
            if (ended) break;
            await new Promise<void>(resolve => { wake = resolve; });
            continue;
          }
          yield queue.shift()!;
        }
        await promptPromise;
      } finally {
        disposed = true;
        if (cancelRequested || !agentEnded || promptRejected) agent.abort();
        ended = true;
        if (timer) clearTimeout(timer);
        streamOptions.signal?.removeEventListener("abort", abort);
        unsubscribe();
        if (activeAbort === abort) activeAbort = undefined;
        await agent.waitForIdle();
      }
    },
    abort() {
      activeAbort?.();
    },
    waitForIdle() {
      return agent.waitForIdle();
    },
  };
}

export async function runPiAgent(options: PiAgentRuntimeOptions): Promise<Agent> {
  const agent = createPiAgent(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = options.onEvent ? agent.subscribe(options.onEvent) : undefined;
  const abort = () => agent.abort();
  if (options.signal?.aborted) {
    unsubscribe?.();
    throw new Error("Pi Agent 执行已取消");
  }
  if (options.signal) {
    options.signal.addEventListener("abort", abort, { once: true });
  }
  if (options.deadlineMs && options.deadlineMs > 0) timer = setTimeout(abort, options.deadlineMs);
  try {
    await agent.prompt(options.prompt);
    return agent;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    await agent.waitForIdle();
  }
}
