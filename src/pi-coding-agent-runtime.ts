import { InMemoryCredentialStore, type Message, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { config } from "./config.js";
import {
  createPiMcpPluginTools,
  formatPiBudgetNote,
  type PiAgentEvent,
  type PiAgentFacade,
  type PiAgentRuntimeOptions,
  type PiAgentStreamInput,
} from "./pi-agent-runtime.js";
import { stringifyModelContent } from "./model-content.js";
import { redactSensitiveValues } from "./request-raw-trace.js";
import { createAgentSlotScheduler, type AgentSlotLease, type AgentSlotScheduler } from "./agent-slot-scheduler.js";

const PI_SESSION_EXPIRATION_MS = 60 * 60 * 1000;
let piSessions = new Map<string, Promise<CodingSessionState>>();
const piSessionRuns = new Map<string, AgentSlotScheduler>();

type CodingSessionState = {
  session: AgentSession;
  toolRegistry: SessionToolRegistry;
  signature: string;
  systemPrompt: string;
  initialized: boolean;
  lastUsedAt: number;
};

type SessionToolRegistry = {
  get(name: string): AgentTool | undefined;
  replace(tools: readonly AgentTool[]): void;
};

function createSessionToolRegistry(initialTools: readonly AgentTool[]): SessionToolRegistry {
  let tools = new Map(initialTools.map(tool => [tool.name, tool]));
  return {
    get: name => tools.get(name),
    replace: nextTools => { tools = new Map(nextTools.map(tool => [tool.name, tool])); },
  };
}

function latestPrompt(messages: BaseMessage[]) {
  const message = [...messages].reverse().find(item => item instanceof HumanMessage || item._getType?.() === "human");
  return message ? stringifyModelContent(message.content) : "";
}

function removePromptMessage(messages: BaseMessage[], prompt: string) {
  const reverseIndex = [...messages].reverse().findIndex(message =>
    (message instanceof HumanMessage || message._getType?.() === "human")
      && stringifyModelContent(message.content) === prompt,
  );
  if (reverseIndex < 0) return messages;
  const index = messages.length - 1 - reverseIndex;
  return messages.filter((_message, messageIndex) => messageIndex !== index);
}

function toAssistantMessage(message: AIMessage, content: string): Message {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const blocks = [
    ...(content ? [{ type: "text" as const, text: content }] : []),
    ...toolCalls.map(call => ({
      type: "toolCall" as const,
      id: String(call.id || "history-tool-call"),
      name: String(call.name || "unknown_tool"),
      arguments: call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {},
    })),
  ];
  return {
    role: "assistant",
    content: blocks,
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
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  } as Message;
}

function toPiMessages(messages: BaseMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    const content = stringifyModelContent(message.content);
    const type = message._getType?.() || "";
    if (type === "human") {
      converted.push({ role: "user", content, timestamp: Date.now() });
      continue;
    }
    if (type === "ai") {
      converted.push(toAssistantMessage(message as AIMessage, content));
      continue;
    }
    if (type === "tool") {
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

export interface PiCodingAgentRuntimeOptions extends Omit<PiAgentRuntimeOptions, "prompt" | "signal" | "deadlineMs" | "onEvent"> {
  contextWindow?: number;
  sessionKey?: string;
}

function modelFor(options: PiCodingAgentRuntimeOptions): Model<"openai-completions"> {
  const modelName = options.model || config.llm.modelName;
  return {
    id: modelName,
    name: modelName,
    api: "openai-completions",
    provider: "wecom-agent",
    baseUrl: options.baseUrl || config.llm.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow || 128_000,
    maxTokens: config.llm.maxOutputTokens || 32_768,
    compat: { supportsUsageInStreaming: true, supportsStrictMode: false },
  };
}

function toolSignature(tools: readonly AgentTool[]) {
  return tools.map(tool => `${tool.name}:${JSON.stringify(tool.parameters)}`).sort().join("|");
}

function toSessionTool<T extends AgentTool>(tool: T, registry: SessionToolRegistry): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ): Promise<AgentToolResult<unknown>> => {
      const currentTool = registry.get(tool.name);
      if (!currentTool) throw new Error(`Pi 工具不可用：${tool.name}`);
      return currentTool.execute(toolCallId, params as never, signal, onUpdate);
    },
  } as ToolDefinition;
}

async function createCodingSession(
  options: PiCodingAgentRuntimeOptions,
  tools: AgentTool[],
  toolRegistry: SessionToolRegistry,
): Promise<CodingSessionState> {
  const cwd = process.cwd();
  const agentDir = cwd;
  const contextWindow = options.contextWindow || 128_000;
  const model = modelFor(options);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("wecom-agent", {
    api: "openai-completions",
    baseUrl: model.baseUrl,
    apiKey: options.apiKey || config.llm.apiKey,
    models: [model],
  });
  await modelRuntime.setRuntimeApiKey("wecom-agent", options.apiKey || config.llm.apiKey);

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: Math.round(contextWindow * 0.4),
      keepRecentTokens: 8_000,
    },
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1_000,
      provider: { maxRetries: 0, maxRetryDelayMs: 1_000 },
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = PiSessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    sessionManager,
    settingsManager,
    noTools: "all",
    tools: tools.map(tool => tool.name),
    customTools: tools.map(tool => toSessionTool(tool, toolRegistry)),
  });
  return {
    session,
    toolRegistry,
    signature: toolSignature(tools),
    systemPrompt: options.systemPrompt,
    initialized: false,
    lastUsedAt: Date.now(),
  };
}

export function resetPiCodingAgentSession(sessionKey: string) {
  const key = sessionKey || "__default__";
  const existing = piSessions.get(key);
  piSessions = new Map([...piSessions].filter(([storedKey]) => storedKey !== key));
  if (existing) {
    void existing.then(state => state.session.dispose()).catch(() => undefined);
  }
}

async function disposeExpiredPiSessions(currentKey: string, now = Date.now()) {
  const retained = new Map<string, Promise<CodingSessionState>>();
  const expired: Promise<CodingSessionState>[] = [];
  for (const [key, pending] of piSessions) {
    if (key === currentKey) {
      retained.set(key, pending);
      continue;
    }
    const state = await pending.catch(() => undefined);
    if (!state) continue;
    if (state.session.isStreaming || now - state.lastUsedAt <= PI_SESSION_EXPIRATION_MS) {
      retained.set(key, pending);
      continue;
    }
    expired.push(Promise.resolve(state));
  }
  piSessions = retained;
  await Promise.allSettled(expired.map(async pending => (await pending).session.dispose()));
}

async function getCodingSession(
  key: string,
  options: PiCodingAgentRuntimeOptions,
  tools: AgentTool[],
  toolRegistry: SessionToolRegistry,
) {
  await disposeExpiredPiSessions(key);
  const existing = piSessions.get(key);
  if (existing) {
    const state = await existing;
    if (
      Date.now() - state.lastUsedAt <= PI_SESSION_EXPIRATION_MS
      && state.signature === toolSignature(tools)
      && state.systemPrompt === options.systemPrompt
    ) {
      state.toolRegistry.replace(tools);
      const refreshedState = { ...state, initialized: true, lastUsedAt: Date.now() };
      const ready = Promise.resolve(refreshedState);
      piSessions = new Map(piSessions).set(key, ready);
      state.session.setActiveToolsByName(tools.map(tool => tool.name));
      return refreshedState;
    }
    state.session.dispose();
    piSessions = new Map([...piSessions].filter(([sessionKey]) => sessionKey !== key));
  }

  const creating = createCodingSession(options, tools, toolRegistry);
  piSessions = new Map(piSessions).set(key, creating);
  try {
    return await creating;
  } catch (error) {
    if (piSessions.get(key) === creating) {
      piSessions = new Map([...piSessions].filter(([sessionKey]) => sessionKey !== key));
    }
    throw error;
  }
}

function eventToMessage(event: PiAgentEvent): BaseMessage | null {
  if (event.type === "agent_end") {
    const message = event.messages[event.messages.length - 1] as { role?: string; stopReason?: string; content?: unknown } | undefined;
    if (!message || message.role !== "assistant" || message.stopReason !== "stop") return null;
    const text = extractAssistantText(message);
    return text ? new AIMessage(text) : null;
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
    return new ToolMessage({
      content: stringifyModelContent(event.result?.content || event.result),
      tool_call_id: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "error" : "success",
    });
  }
  return null;
}

function logCompactionEvent(event: Extract<AgentSessionEvent, { type: "compaction_start" | "compaction_end" }>) {
  if (event.type === "compaction_start") {
    console.log(JSON.stringify({ event: event.type, reason: event.reason }));
    return;
  }
  console.log(JSON.stringify({
    event: event.type,
    reason: event.reason,
    aborted: event.aborted,
    willRetry: event.willRetry,
    ...(event.result ? {
      tokensBefore: event.result.tokensBefore,
      estimatedTokensAfter: event.result.estimatedTokensAfter,
    } : {}),
    ...(event.errorMessage ? { errorMessage: redactSensitiveValues(event.errorMessage).replace(/\s+/gu, " ").slice(0, 300) } : {}),
  }));
}

function asPiAgentEvent(event: AgentSessionEvent): PiAgentEvent | null {
  if (event.type === "agent_settled"
    || event.type === "queue_update"
    || event.type === "compaction_start"
    || event.type === "compaction_end"
    || event.type === "entry_appended"
    || event.type === "session_info_changed"
    || event.type === "thinking_level_changed"
    || event.type === "auto_retry_start"
    || event.type === "auto_retry_end"
    || event.type === "summarization_retry_scheduled"
    || event.type === "summarization_retry_attempt_start"
    || event.type === "summarization_retry_finished"
    || event.type === "bash_execution_update") {
    return null;
  }
  return event as PiAgentEvent;
}

export function createPiCodingAgentFacade(options: PiCodingAgentRuntimeOptions): PiAgentFacade {
  let activeAbort: (() => void) | undefined;
  let idle: Promise<void> = Promise.resolve();

  const streamPiEvents = async function* (
    prompt: string,
    streamOptions: { signal?: AbortSignal; deadlineMs?: number } = {},
    contextMessages: BaseMessage[] = [],
  ): AsyncGenerator<PiAgentEvent> {
    const startedAt = Date.now();
    const deadlineMs = streamOptions.deadlineMs ?? config.llm.requestTimeoutMs;
    const runAbort = new AbortController();
    const budget = () => formatPiBudgetNote(startedAt, deadlineMs);
    const runtimeTools = createPiMcpPluginTools(options.tools || [], {
      toolTimeoutMs: options.toolTimeoutMs || config.llm.toolTimeoutMs,
      signal: runAbort.signal,
      budget,
    });
    const toolRegistry = createSessionToolRegistry(runtimeTools);
    const key = options.sessionKey || "__default__";
    const sessionRuns = piSessionRuns.get(key) || createAgentSlotScheduler(1);
    piSessionRuns.set(key, sessionRuns);
    let sessionLease: AgentSlotLease | undefined;
    let state: CodingSessionState | undefined;
    let unsubscribe: (() => void) | undefined;
    let wake: (() => void) | undefined;
    let ended = false;
    let terminal = false;
    let promptRejected = false;
    let compactionFailed = false;
    let cancelRequested = false;
    const queue: PiAgentEvent[] = [];
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const abort = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      ended = true;
      runAbort.abort();
      void state?.session.abort().catch(() => undefined);
      notify();
    };
    activeAbort = abort;
    if (streamOptions.signal?.aborted) abort();
    else streamOptions.signal?.addEventListener("abort", abort, { once: true });
    const timer = deadlineMs > 0 ? setTimeout(abort, deadlineMs) : undefined;

    try {
      sessionLease = await sessionRuns.acquire(runAbort.signal);
      if (cancelRequested || runAbort.signal.aborted) throw new Error("Pi Agent 执行已取消");
      state = await getCodingSession(key, options, runtimeTools, toolRegistry);
      if (cancelRequested || runAbort.signal.aborted) throw new Error("Pi Agent 执行已取消");
      state.toolRegistry.replace(runtimeTools);
      unsubscribe = state.session.subscribe(event => {
        if (event.type === "compaction_start" || event.type === "compaction_end") {
          logCompactionEvent(event);
        }
        if (event.type === "compaction_end" && (event.aborted || event.errorMessage)) {
          compactionFailed = true;
          return;
        }
        if (event.type === "agent_end" && event.willRetry) return;
        if (event.type === "agent_end") return;
        if (event.type === "agent_settled") {
          const finalMessages = state?.session.messages || [];
          queue.push({ type: "agent_end", messages: [...finalMessages] } as PiAgentEvent);
          terminal = true;
          ended = true;
          notify();
          return;
        }
        const converted = asPiAgentEvent(event);
        if (!converted) return;
        if (converted.type === "agent_end") {
          terminal = true;
          ended = true;
        }
        queue.push(converted);
        notify();
      });

      if (!state.initialized) {
        const history = toPiMessages(removePromptMessage(contextMessages, prompt));
        for (const message of history) state.session.sessionManager.appendMessage(message);
        if (history.length > 0) {
          state.session.agent.state.messages = state.session.sessionManager.buildSessionContext().messages;
        }
        const initializedState = { ...state, initialized: true };
        piSessions = new Map(piSessions).set(key, Promise.resolve(initializedState));
        state = initializedState;
      }

      const promptPromise = state.session.sendUserMessage(prompt, { expandPromptTemplates: false })
        .catch(error => {
          promptRejected = true;
          ended = true;
          notify();
          throw error;
        });
      void promptPromise.catch(() => undefined);
      idle = promptPromise.then(() => state?.session.waitForIdle()).then(() => undefined);
      void idle.catch(() => undefined);

      while (!ended || queue.length > 0) {
        if (queue.length === 0) {
          if (ended) break;
          await new Promise<void>(resolve => { wake = resolve; });
          continue;
        }
        yield queue.shift()!;
      }
      await promptPromise;
      if (!terminal && !cancelRequested) throw new Error("Pi Agent 未产生终态");
    } finally {
      unsubscribe?.();
      if (compactionFailed && !cancelRequested) {
        resetPiCodingAgentSession(key);
      }
      if (cancelRequested || !terminal || promptRejected) {
        await state?.session.abort().catch(() => undefined);
      }
      if (timer) clearTimeout(timer);
      streamOptions.signal?.removeEventListener("abort", abort);
      if (activeAbort === abort) activeAbort = undefined;
      await state?.session.waitForIdle().catch(() => undefined);
      sessionLease?.release();
      if (sessionRuns.activeCount === 0 && sessionRuns.queuedCount === 0 && piSessionRuns.get(key) === sessionRuns) {
        piSessionRuns.delete(key);
      }
    }
  };

  return {
    streamPiEvents,
    async *stream(input: PiAgentStreamInput, streamOptions = {}) {
      for await (const event of streamPiEvents(latestPrompt(input.messages), streamOptions, input.messages)) {
        const message = eventToMessage(event);
        if (message) yield [message, {}];
      }
    },
    abort() {
      activeAbort?.();
    },
    waitForIdle() {
      return idle;
    },
  };
}
