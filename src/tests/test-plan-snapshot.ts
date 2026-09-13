import assert from "node:assert/strict";
import { createRuntimeTodoList, completeTodoItem, renderTodoStepsForHeartbeat, snapshotUserFacingTodoSteps, syncRuntimeAuditTodoPlan, startTodoItem } from "../runtime-todolist.js";
import { detectReplyModeCommand, isDirectMatchIntent } from "../wecom-adapter.js";
import { SessionManager } from "../session-manager.js";

// 1. 冻结可见步骤：后续新增审核项不进入用户可见清单
const todoList = createRuntimeTodoList();
completeTodoItem(todoList, "message_parsed", "parsed");
completeTodoItem(todoList, "planner_checked", "planned");
const frozen = snapshotUserFacingTodoSteps(todoList);
const firstRender = renderTodoStepsForHeartbeat(todoList, "", frozen);
assert.ok(firstRender.includes("✓ 接收并理解问题"), "冻结清单应显示已完成步骤");
assert.ok(firstRender.includes("○ 查询相关信息"), "冻结清单应显示未完成步骤");

syncRuntimeAuditTodoPlan(todoList, {
  question: "测试问题",
  plannerIntent: "SQL",
});
const secondRender = renderTodoStepsForHeartbeat(todoList, "", frozen);
assert.ok(!secondRender.includes("核对 SQL 或数据依据"), "后续新增审核项不应进入冻结清单");
completeTodoItem(todoList, "tools_loaded", "loaded");
const thirdRender = renderTodoStepsForHeartbeat(todoList, "", frozen);
assert.ok(thirdRender.includes("✓ 查询相关信息"), "冻结项状态变化应反映到清单");

// 2. 冻结后新增项不应改变快照行数和顺序
const frozenLines = thirdRender.split("\n");
const fullLines = renderTodoStepsForHeartbeat(todoList, "").split("\n");
assert.ok(frozenLines.length < fullLines.length, "冻结快照行数应少于全量清单行数");

// 3. 默认行为不变（不传冻结项时渲染全量）
const fullRender = renderTodoStepsForHeartbeat(todoList, "");
assert.ok(fullRender.includes("核对 SQL 或数据依据"), "全量渲染应包含后续新增审核项");

// 4. @提及 /dev 指令匹配
const mentionCases: Array<[string, "dev" | "business" | null, string]> = [
  ["@OA智能助手 /dev", "dev", ""],
  ["@xxx /dev", "dev", ""],
  ["@OA智能助手 /dev 查一下订单", "dev", "查一下订单"],
  ["@OA智能助手 /business", "business", ""],
  ["@xxx /business 继续", "business", "继续"],
  ["@OA智能助手 帮我查订单", null, "帮我查订单"],
  ["/dev", "dev", ""],
];
for (const [input, expectedMode, expectedText] of mentionCases) {
  const result = detectReplyModeCommand(input);
  assert.equal(result.modeSwitch, expectedMode, `指令匹配失败: ${input}`);
  if (expectedMode) {
    assert.equal(result.strippedText, expectedText, `指令文本剥离失败: ${input}`);
  }
}

// 5. 进行中项渲染旋转帧而非静态 ○
const animList = createRuntimeTodoList();
completeTodoItem(animList, "message_parsed", "parsed");
startTodoItem(animList, "planner_checked");
const frameRender = renderTodoStepsForHeartbeat(animList, "◐", snapshotUserFacingTodoSteps(animList));
assert.ok(frameRender.includes("◐ 分析处理思路"), `进行中项应显示旋转帧: ${frameRender}`);
assert.ok(frameRender.includes("○ 查询相关信息"), "未开始项仍显示 ○");
assert.ok(!frameRender.includes("○ 分析处理思路"), "进行中项不应显示静态 ○");
// 无帧时回退 ○
const noFrameRender = renderTodoStepsForHeartbeat(animList, "", snapshotUserFacingTodoSteps(animList));
assert.ok(noFrameRender.includes("○ 分析处理思路"), "无旋转帧时进行中项回退 ○");

// 6. 直接匹配意图分流：SQL/CONFIG/DOC/AUTH；FLOW/API 归逻辑推理
assert.equal(isDirectMatchIntent("SQL"), true);
assert.equal(isDirectMatchIntent("config"), true);
assert.equal(isDirectMatchIntent("DOC"), true);
assert.equal(isDirectMatchIntent("AUTH"), true, "权限/角色/菜单/鉴权查询属直接匹配");
assert.equal(isDirectMatchIntent("FLOW"), false, "处理逻辑/步骤/业务逻辑梳理属逻辑推理");
assert.equal(isDirectMatchIntent("API"), false, "接口处理逻辑属逻辑推理");
assert.equal(isDirectMatchIntent("BUG"), false);
assert.equal(isDirectMatchIntent("PERF"), false);
assert.equal(isDirectMatchIntent(null), false);

// 7. 计划持久化：session 存取与清理
const sm = new SessionManager();
const sessionKey = "plan-persist-test";
const storedSteps = [
  { id: "message_parsed", task: "接收并理解问题", status: "done" },
  { id: "planner_checked", task: "分析处理思路", status: "done" },
  { id: "tools_loaded", task: "查询相关信息", status: "pending" },
];
sm.setLastPlanSteps(sessionKey, storedSteps);
assert.deepEqual(sm.getLastPlanSteps(sessionKey), storedSteps, "计划应能持久化读取");
sm.clearLastPlanSteps(sessionKey);
assert.equal(sm.getLastPlanSteps(sessionKey), undefined, "计划应能清理");

console.log("plan snapshot 与 @提及指令验证通过");
