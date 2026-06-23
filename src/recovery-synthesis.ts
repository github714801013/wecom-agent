const PROGRESS_LIMIT_RECOVERY_RULES = [
  "注意：当前任务由于逻辑复杂或工具调用达到上限，必须基于已有工具证据输出可直接发送给用户的回答。",
  "",
  "恢复输出规则：",
  "1. 禁止输出“继续核实中”“现在读取”“准备查看”“已定位候选，继续”等阶段性处理话术。",
  "2. 如果已有工具证据只定位到候选仓库、文件、方法或代码片段，也要先给出已查到的阶段性结论，再列出最小缺口。",
  "3. 对代码取值逻辑、按钮显示条件、字段来源等问题，优先基于代码证据说明入口、文件、关键字段和判断链路。",
  "4. 除非最终回答输出具体 SQL、生产取数 SQL，或声明已经做过 dev SQL 校验，否则不要把问题转成 SQL/dev 校验缺口；必要时明确“不涉及 SQL 输出”。",
  "5. 如果为了说明代码逻辑引用源码中的 SQL/Mapper 片段，但没有执行 dev 校验，必须明确标记“dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构”。",
  "6. 如果证据不足，最小缺口必须具体到项目名、页面路径、字段名、接口、文件路径或需要用户确认的二选一范围，不能只泛泛要求补充目标系统/页面/字段。",
].join("\n");

const CODE_INFERRED_SQL_AUDIT_MARKER = "dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构";
const SQL_SNIPPET_PATTERN = /```sql|\bselect\b[\s\S]{0,500}\bfrom\b|\bshow\b[\s\S]{0,120}\b(?:tables|columns|databases|create|index|indexes|variables|status)\b|\bexplain\b[\s\S]{0,500}\bselect\b/iu;

export function buildProgressLimitRecoverySystemPrompt(businessPrompt: string) {
  return `${businessPrompt}\n\n${PROGRESS_LIMIT_RECOVERY_RULES}`;
}

export function ensureRecoverySqlAuditMarker(answer: string) {
  if (!SQL_SNIPPET_PATTERN.test(answer) || answer.includes(CODE_INFERRED_SQL_AUDIT_MARKER)) {
    return answer;
  }

  return `${answer.trim()}\n\nSQL 校验说明：${CODE_INFERRED_SQL_AUDIT_MARKER}。`;
}
