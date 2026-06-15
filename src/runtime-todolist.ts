import { tool } from "@langchain/core/tools";
import { z } from "zod";

export type RuntimeTodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface RuntimeTodoItem {
  id: string;
  task: string;
  status: RuntimeTodoStatus;
  evidence?: string;
}

export interface RuntimeTodoList {
  items: RuntimeTodoItem[];
}

const DEFAULT_RUNTIME_TODO_ITEMS: Array<Pick<RuntimeTodoItem, "id" | "task">> = [
  { id: "message_parsed", task: "解析用户消息并确定当前问题" },
  { id: "planner_checked", task: "完成问题规划或记录跳过原因" },
  { id: "tools_loaded", task: "加载 MCP 工具和项目范围" },
  { id: "analysis_finished", task: "完成业务分析节点执行" },
  { id: "project_scope_audited", task: "审核代码包、仓库、项目和用户目标范围一致性" },
  { id: "sql_correctness_audited", task: "审核 SQL 正确性、dev 校验或 dev 缺表代码反推路径" },
  { id: "evidence_audited", task: "审核结论证据完整性、字段语义和查询收敛" },
  { id: "execution_flow_audited", task: "审核接口链路、缺失日志和下游触达条件的执行链完整性" },
  { id: "owner_contact_audited", task: "审核建议处理是否需要联系相关开发人员" },
  { id: "final_format_audited", task: "审核过程标签和最终结论分离" },
  { id: "final_checked", task: "确认最终回答不是阶段性进度" },
];

const PROGRESS_ONLY_PATTERN = /(?:继续核实中|继续读取|继续确认|准备输出结论)[。.!！\s]*$/u;
const SQL_SIGNAL_PATTERN = /\b(select|show|explain|from|where|join|mapper|sql)\b|生产\s*SQL|prod_sql_required|数据库|数据表|表名|字段名|dev\s*库|dev\s*环境/iu;
const CODE_SCOPE_PATTERN = /项目|仓库|代码包|模块|接口|页面|入口|类名|方法名|controller|service|mapper|repo|package|GitNexus/iu;
const AUDIT_TODO_IDS = new Set([
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
  "final_format_audited",
]);

export function createRuntimeTodoList(
  items: Array<Pick<RuntimeTodoItem, "id" | "task">> = DEFAULT_RUNTIME_TODO_ITEMS
): RuntimeTodoList {
  return {
    items: items.map(item => ({
      ...item,
      status: "pending",
    })),
  };
}

function findTodoItem(todoList: RuntimeTodoList, id: string) {
  const item = todoList.items.find(todo => todo.id === id);
  if (!item) {
    throw new Error(`Runtime TodoList item not found: ${id}`);
  }
  return item;
}

export function startTodoItem(todoList: RuntimeTodoList, id: string) {
  for (const item of todoList.items) {
    if (item.status === "in_progress" && item.id !== id) {
      item.status = "pending";
    }
  }

  const item = findTodoItem(todoList, id);
  if (item.status !== "done") {
    item.status = "in_progress";
  }
}

export function completeTodoItem(todoList: RuntimeTodoList, id: string, evidence: string) {
  if (!evidence.trim()) {
    throw new Error(`Runtime TodoList evidence is required: ${id}`);
  }

  const item = findTodoItem(todoList, id);
  item.status = "done";
  item.evidence = evidence.trim();
}

export function blockTodoItem(todoList: RuntimeTodoList, id: string, evidence: string) {
  const item = findTodoItem(todoList, id);
  item.status = "blocked";
  item.evidence = evidence.trim() || "未记录阻塞原因";
}

export function getIncompleteTodoItems(todoList: RuntimeTodoList) {
  return todoList.items.filter(item => item.status !== "done");
}

export function getIncompleteAuditTodoItems(todoList: RuntimeTodoList) {
  return todoList.items.filter(item => AUDIT_TODO_IDS.has(item.id) && item.status !== "done");
}

export function assertTodoListComplete(todoList: RuntimeTodoList) {
  const incomplete = getIncompleteTodoItems(todoList);
  if (incomplete.length > 0) {
    const summary = incomplete.map(item => `${item.id}:${item.status}`).join(", ");
    throw new Error(`Runtime TodoList incomplete: ${summary}`);
  }
}

export function isFinalAnswerReady(content: string) {
  const normalized = content.trim();
  return Boolean(normalized)
    && !PROGRESS_ONLY_PATTERN.test(normalized)
    && !normalized.includes("> 🔍 正在调用:");
}

export function buildProjectScopeAuditEvidence(question: string, answer: string, repoHints: string[] = []) {
  const combined = `${question}\n${answer}`;
  if (!CODE_SCOPE_PATTERN.test(combined)) {
    return "非代码范围问题，项目/代码包一致性不适用";
  }

  if (repoHints.length > 0) {
    return `已按项目范围审核，repoHints=${repoHints.join(",")}`;
  }

  return "已审核回答中的项目、仓库、入口或接口锚点，未检测到显式 repoHint";
}

export function buildSqlAuditEvidence(question: string, answer: string) {
  const combined = `${question}\n${answer}`;
  if (!SQL_SIGNAL_PATTERN.test(combined)) {
    return "不涉及 SQL，SQL 正确性审核不适用";
  }

  if (answer.includes("dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构")) {
    return "涉及 SQL，dev 缺表，已标记代码反推结构路径";
  }

  if (/dev\s*(环境|库).*(验证|校验)|已验证\s*dev|查询不报错/u.test(answer)) {
    return "涉及 SQL，已标记 dev 执行校验路径";
  }

  return "涉及 SQL，需在最终回答中说明 dev 校验或 dev 缺表代码反推路径";
}

export function buildEvidenceAuditEvidence(answer: string, toolResultCount = 0) {
  if (!answer.trim()) {
    return "回答为空，证据审核未通过";
  }

  return `已审核结论证据和查询收敛，toolResults=${toolResultCount}`;
}

export function summarizeTodoList(todoList: RuntimeTodoList) {
  return todoList.items
    .map(item => {
      const evidence = item.evidence ? ` (${item.evidence})` : "";
      return `${item.id}=${item.status}${evidence}`;
    })
    .join("; ");
}

function getAuditTodoFailureGuide(item: RuntimeTodoItem) {
  const baseReason = item.status === "blocked"
    ? item.evidence || "模型主动标记该审核项阻塞，但未说明原因"
    : `模型未调用 runtime_todolist_update 将 ${item.id} 标记为 done`;

  if (item.id === "project_scope_audited") {
    return {
      title: "代码包/项目范围一致性审核未完成",
      reason: baseReason,
      next: "需要明确目标 repo、代码包、模块、接口、页面或入口，并说明命中的代码证据与用户指定范围一致；如果不涉及代码范围，也要通过工具标记“不适用”及原因。",
    };
  }

  if (item.id === "sql_correctness_audited") {
    return {
      title: "SQL 正确性审核未完成",
      reason: baseReason,
      next: "如果问题涉及 SQL，需要补充完整只读 SQL 的 dev 执行校验结果；如果 dev 库没有对应表，需要通过目标项目代码反推表名、字段、Mapper/SQL、实体映射或调用链，并明确标记“dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构”。如果不涉及 SQL，也要通过工具标记“不涉及 SQL”。",
    };
  }

  if (item.id === "evidence_audited") {
    return {
      title: "结论证据完整性审核未完成",
      reason: baseReason,
      next: "需要说明核心结论由哪些用户输入、工具结果、代码片段、数据库结果或业务规则支撑，并确认字段语义和查询已经收敛；证据不足时应触发 Human Loop 或说明最小缺口。",
    };
  }

  if (item.id === "execution_flow_audited") {
    return {
      title: "执行链完整性审核未完成",
      reason: baseReason,
      next: "涉及接口链路、缺失日志、未触达下游、下游触达条件、回调、MQ、外部系统推送或状态流转时，需要沿真实执行路径核对入口、分发、前置查询、状态映射、顺序分支门槛、下游发送条件和异常捕获；如果更靠前的短路条件已由代码和已知入参同时满足，应优先落在前置短路点，后续未执行到的租户规模、域名配置、MQ 等条件不得反过来作为主因；需要生产数据确认的门槛必须输出取数验证方式，等待用户验证后再继续下一层。不涉及此类问题时，也要标记不适用及原因。",
    };
  }

  if (item.id === "owner_contact_audited") {
    return {
      title: "开发人员联系建议审核未完成",
      reason: baseReason,
      next: "涉及代码缺陷、配置异常、流程实现、历史逻辑归属或需要推动修复时，需要在建议处理中提示联系相关开发人员；如果当前工具列表存在 git_author_trace，只能基于最终结论实际引用的仓库、文件、方法、代码片段、symbol uid 或接口入口追溯联系人，不得使用最终未引用的候选文件；多个线索命中时，按“与最终结论最相关的修改优先、同等相关时最新修改优先”选择开发人员。若不涉及代码或无需推动开发处理，也要标记不适用及原因。",
    };
  }

  if (item.id === "final_format_audited") {
    return {
      title: "最终输出格式审核未完成",
      reason: baseReason,
      next: "需要完成过程标签和最终结论分离审核：确认阶段性过程已使用 agent_progress 标签承载，最终结论已使用 final_answer 标签承载，且发送给用户前会去除过程标签和过程内容，只保留最终结论。",
    };
  }

  return {
    title: `${item.task}未完成`,
    reason: baseReason,
    next: "需要补充该审核项的完成证据，或通过工具标记 blocked 并说明阻塞原因。",
  };
}

export function buildIncompleteAuditTodoMessage(items: RuntimeTodoItem[]) {
  const details = items.map((item, index) => {
    const guide = getAuditTodoFailureGuide(item);
    return `${index + 1}. ${guide.title}\n原因：${guide.reason}\n下一步：${guide.next}`;
  }).join("\n\n");

  return `审核未完成，当前回答暂不发送最终结论。\n\n${details}`;
}

export function buildRuntimeTodoTool(todoList: RuntimeTodoList) {
  return tool(
    async ({ itemId, status, evidence }) => {
      if (status === "done") {
        completeTodoItem(todoList, itemId, evidence);
      } else if (status === "blocked") {
        blockTodoItem(todoList, itemId, evidence);
      } else {
        startTodoItem(todoList, itemId);
      }

      return summarizeTodoList(todoList);
    },
    {
      name: "runtime_todolist_update",
      description: [
        "更新当前回答的运行时 TodoList。",
        "模型必须在最终回答前调用本工具完成审核步骤。",
        "可用 itemId：project_scope_audited（代码包/仓库/项目范围一致性审核）、",
        "sql_correctness_audited（SQL 正确性、dev 校验或 dev 缺表代码反推审核）、",
        "evidence_audited（结论证据完整性、字段语义和查询收敛审核）、",
        "execution_flow_audited（接口链路、缺失日志、下游触达条件、回调、MQ、外部系统推送和状态流转的执行链完整性审核）、",
        "owner_contact_audited（建议处理中的开发人员联系建议审核；git_author_trace 只能基于最终结论实际引用证据追溯联系人，并按相关性优先、最新修改次之选择开发人员）、",
        "final_format_audited（过程标签和最终结论分离审核）。",
        "每次标记 done 必须提供 evidence；没有证据时标记 blocked。",
      ].join(""),
      schema: z.object({
        itemId: z.enum(["project_scope_audited", "sql_correctness_audited", "evidence_audited", "execution_flow_audited", "owner_contact_audited", "final_format_audited"]),
        status: z.enum(["in_progress", "done", "blocked"]),
        evidence: z.string().describe("完成或阻塞该审核项的具体证据；done 时不能为空。"),
      }),
    }
  );
}
