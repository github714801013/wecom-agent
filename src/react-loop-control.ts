import { parseArgs, type ToolContextRecord } from "./tool-context-filter.js";
import { stringifyModelContent } from "./model-content.js";

export type ReactLoopNode = "START" | "init" | "plan" | "act" | "evaluateAction" | "executeTool" | "observeUpdate" | "evaluateProgress" | "final" | "askUser" | "revisePlan" | "abort" | "END";
export type ReactActionType = "tool" | "final" | "askUser" | "revisePlan" | "abort";

export interface ReactAction {
  type: ReactActionType;
  toolName?: string;
  args?: unknown;
  content?: string;
}

export interface ReactLoopControlOptions {
  maxToolActions?: number;
  maxRepeatedToolActions?: number;
  maxInvalidActions?: number;
  // 查询类工具（名称含 query）的独立预算：查询不收敛是耗时主因，超限强制收敛
  maxQueryToolActions?: number;
}

export interface ReactLoopDecision {
  allowed: boolean;
  currentNode: ReactLoopNode;
  nextNode: ReactLoopNode;
  reason: string;
  signature?: string;
}

export interface ReactProgressInput {
  latestObservation?: ToolContextRecord;
  finalContent?: string;
  hasPendingToolCalls?: boolean;
}

export interface ReactLoopController {
  evaluateAction(action: ReactAction): ReactLoopDecision;
  observeUpdate(record: ToolContextRecord): ToolContextRecord;
  evaluateProgress(input?: ReactProgressInput): ReactLoopDecision;
  getObservations(): ToolContextRecord[];
}

export const REACT_LOOP_GRAPH: Record<ReactLoopNode, ReactLoopNode[]> = {
  START: ["init"],
  init: ["plan"],
  plan: ["act"],
  act: ["evaluateAction"],
  evaluateAction: ["executeTool", "final", "askUser", "revisePlan", "abort"],
  executeTool: ["observeUpdate"],
  observeUpdate: ["evaluateProgress"],
  evaluateProgress: ["act", "revisePlan", "final", "askUser", "abort"],
  final: ["END"],
  askUser: ["END"],
  revisePlan: ["act"],
  abort: ["END"],
  END: [],
};

const DEFAULT_MAX_TOOL_ACTIONS = 64;
const DEFAULT_MAX_REPEATED_TOOL_ACTIONS = 2;
const DEFAULT_MAX_INVALID_ACTIONS = 3;
const DEFAULT_MAX_QUERY_TOOL_ACTIONS = 8;
const RUNTIME_TODO_TOOL_NAME = "runtime_todolist_update";
const REACT_LOOP_CONTROL_CODE = "REACT_LOOP_CONTROL";

function isQueryToolName(toolName: string) {
  return /query|search|grep|zoekt|gitnexus/i.test(toolName);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, item && typeof item === "object" ? JSON.parse(stableJson(item)) : item]);
  return JSON.stringify(Object.fromEntries(entries));
}

function normalizeArgs(args: unknown) {
  if (typeof args === "string") return parseArgs(args);
  if (args && typeof args === "object") return args;
  return {};
}

function stringifyArgs(args: unknown) {
  return stableJson(normalizeArgs(args));
}

function stringifyToolResult(result: unknown) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    return stringifyModelContent((result as { content?: unknown }).content);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function isEvidenceToolName(toolName: string) {
  return toolName !== RUNTIME_TODO_TOOL_NAME;
}

function buildToolSignature(toolName: string, args: unknown) {
  return `${toolName}:${stringifyArgs(args)}`;
}

function terminalNodeForAction(type: ReactActionType): ReactLoopNode {
  if (type === "askUser") return "askUser";
  if (type === "revisePlan") return "revisePlan";
  if (type === "abort") return "abort";
  return "final";
}

function createDecision(input: {
  allowed: boolean;
  currentNode: ReactLoopNode;
  nextNode: ReactLoopNode;
  reason: string;
  signature?: string;
}): ReactLoopDecision {
  return input;
}

function createBlockedToolResult(decision: ReactLoopDecision) {
  return `[${REACT_LOOP_CONTROL_CODE}] ${decision.reason}。当前节点：${decision.currentNode}，建议下一节点：${decision.nextNode}。请不要继续重复执行相同工具，改为修正计划、询问用户、输出已有结论或中止。`;
}

function buildObservation(toolName: string, args: unknown, result: unknown): ToolContextRecord {
  return {
    id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: toolName,
    args: stringifyArgs(args),
    content: stringifyToolResult(result),
  };
}

export function createReactLoopController(options: ReactLoopControlOptions = {}): ReactLoopController {
  const maxToolActions = options.maxToolActions ?? DEFAULT_MAX_TOOL_ACTIONS;
  const maxRepeatedToolActions = options.maxRepeatedToolActions ?? DEFAULT_MAX_REPEATED_TOOL_ACTIONS;
  const maxInvalidActions = options.maxInvalidActions ?? DEFAULT_MAX_INVALID_ACTIONS;
  const maxQueryToolActions = options.maxQueryToolActions ?? DEFAULT_MAX_QUERY_TOOL_ACTIONS;
  const signatureCounts = new Map<string, number>();
  const observations: ToolContextRecord[] = [];
  let evidenceToolActions = 0;
  let invalidActions = 0;
  let queryToolActions = 0;

  return {
    evaluateAction(action: ReactAction): ReactLoopDecision {
      if (action.type !== "tool") {
        return createDecision({
          allowed: true,
          currentNode: "evaluateAction",
          nextNode: terminalNodeForAction(action.type),
          reason: `动作进入终态：${action.type}`,
        });
      }

      if (!action.toolName) {
        invalidActions += 1;
        return createDecision({
          allowed: false,
          currentNode: "evaluateAction",
          nextNode: invalidActions >= maxInvalidActions ? "abort" : "revisePlan",
          reason: `非法动作：工具动作缺少 toolName，非法次数 ${invalidActions}/${maxInvalidActions}`,
        });
      }

      const signature = buildToolSignature(action.toolName, action.args);
      const signatureCount = (signatureCounts.get(signature) || 0) + 1;
      signatureCounts.set(signature, signatureCount);

      if (signatureCount > maxRepeatedToolActions) {
        return createDecision({
          allowed: false,
          currentNode: "evaluateAction",
          nextNode: "revisePlan",
          reason: `重复工具动作超过限制：${action.toolName}，重复次数 ${signatureCount}/${maxRepeatedToolActions}`,
          signature,
        });
      }

      if (isQueryToolName(action.toolName)) {
        if (queryToolActions >= maxQueryToolActions) {
          return createDecision({
            allowed: false,
            currentNode: "evaluateAction",
            nextNode: "final",
            reason: `查询预算已耗尽：${queryToolActions}/${maxQueryToolActions}。请停止继续查询，基于已有证据组织答案。`,
            signature,
          });
        }
        queryToolActions += 1;
      }

      if (isEvidenceToolName(action.toolName)) {
        if (evidenceToolActions >= maxToolActions) {
          return createDecision({
            allowed: false,
            currentNode: "evaluateAction",
            nextNode: "final",
            reason: `工具预算已耗尽：${evidenceToolActions}/${maxToolActions}`,
            signature,
          });
        }
        evidenceToolActions += 1;
      }

      return createDecision({
        allowed: true,
        currentNode: "evaluateAction",
        nextNode: "executeTool",
        reason: `动作审核通过：${action.toolName}`,
        signature,
      });
    },

    observeUpdate(record: ToolContextRecord) {
      observations.push(record);
      return record;
    },

    evaluateProgress(input: ReactProgressInput = {}): ReactLoopDecision {
      const latestObservation = input.latestObservation || observations[observations.length - 1];
      const finalContent = input.finalContent?.trim();

      if (finalContent) {
        return createDecision({
          allowed: true,
          currentNode: "evaluateProgress",
          nextNode: "final",
          reason: "已形成最终内容",
        });
      }

      if (input.hasPendingToolCalls) {
        return createDecision({
          allowed: true,
          currentNode: "evaluateProgress",
          nextNode: "act",
          reason: "仍有待执行工具动作，继续 act",
        });
      }

      if (!latestObservation) {
        return createDecision({
          allowed: true,
          currentNode: "evaluateProgress",
          nextNode: "askUser",
          reason: "暂无观察结果，需补充信息",
        });
      }

      if (/error|exception|failed|timeout|报错|失败|超时/i.test(latestObservation.content)) {
        return createDecision({
          allowed: true,
          currentNode: "evaluateProgress",
          nextNode: "revisePlan",
          reason: `观察结果包含失败信号：${latestObservation.name}`,
        });
      }

      return createDecision({
        allowed: true,
        currentNode: "evaluateProgress",
        nextNode: "act",
        reason: `已沉淀观察结果：${latestObservation.name}`,
      });
    },

    getObservations() {
      return [...observations];
    },
  };
}

export function wrapToolsWithReactLoopControl<T extends any[]>(tools: T, controller = createReactLoopController()): T {
  return tools.map(tool => {
    const wrappedTool = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
    const toolName = String(tool?.name || "unknown");

    if (typeof tool?.invoke === "function") {
      const invoke = tool.invoke.bind(tool);
      wrappedTool.invoke = async (args: unknown, ...rest: unknown[]) => {
        const decision = controller.evaluateAction({ type: "tool", toolName, args });
        if (!decision.allowed) {
          const blockedResult = createBlockedToolResult(decision);
          controller.observeUpdate(buildObservation(toolName, args, blockedResult));
          return blockedResult;
        }

        const result = await invoke(args, ...rest);
        const observation = controller.observeUpdate(buildObservation(toolName, args, result));
        controller.evaluateProgress({ latestObservation: observation });
        return result;
      };
    }

    if (typeof tool?.call === "function") {
      const call = tool.call.bind(tool);
      wrappedTool.call = async (args: unknown, ...rest: unknown[]) => {
        const decision = controller.evaluateAction({ type: "tool", toolName, args });
        if (!decision.allowed) {
          const blockedResult = createBlockedToolResult(decision);
          controller.observeUpdate(buildObservation(toolName, args, blockedResult));
          return blockedResult;
        }

        const result = await call(args, ...rest);
        const observation = controller.observeUpdate(buildObservation(toolName, args, result));
        controller.evaluateProgress({ latestObservation: observation });
        return result;
      };
    }

    return wrappedTool;
  }) as T;
}
