import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  buildIntermediateStreamContent,
  buildProgressStreamContent,
  buildThinkingHeartbeatContent,
  collapseProgressUpdates,
  getProcessingFrame,
} from "../progress-updates.js";

const longProgress = "已读取问题，当前缺少直接证据，继续核实中。已确认存在多个代码仓库，继续核实中。已获取仓库清单，继续核实中。";

assert.equal(
  collapseProgressUpdates(longProgress),
  "已获取仓库清单，继续核实中。",
  "progress-only content should keep only the latest progress sentence",
);

assert.equal(
  buildProgressStreamContent(longProgress, ["> 正在调用: remote_gitnexus_query..."]),
  "已获取仓库清单，继续核实中。\n\n> 正在调用: remote_gitnexus_query...",
  "streaming content should show latest progress plus active tool call",
);

assert.equal(
  collapseProgressUpdates("已定位到售后维修相关页面目录，候选页面集中在 after-service/repair-list 与 repair-refund，继续核实撤销按钮配置。已反查到权限判断文件，继续核实中。"),
  "已反查到权限判断文件，继续核实中。",
  "progress collapse should keep latest progress sentence when older sentence contains extra details",
);

assert.equal(
  collapseProgressUpdates(`${longProgress}\n\n最终结论：当前规则不允许切换。`),
  "最终结论：当前规则不允许切换。",
  "final content should drop stale progress sentences when a conclusion exists",
);

assert.equal(
  collapseProgressUpdates("我需要核实生产者侧和消费者侧。\n\n我需要确认 RabbitMQ vhost 配置。\n\n结论：cm_returned_imeis 用于串号转现退单。"),
  "结论：cm_returned_imeis 用于串号转现退单。",
  "final content should drop plain verification prelude before the conclusion",
);

const mixedDiagnosticProgress = `你提供的 curl、请求参数、Cookie、Header 以及截图中的错误信息已经足够定位问题方向：接口 doSendWuLiuV2 在 wlCompany=jingdong 时，后端调用京东开放平台 API 返回 code=18，即 accessToken=null，属于京东授权 Token 缺失或未正确获取，与你端的登录 Token 无关。

我会继续围绕现有锚点核实后端获取京东 access_token 的逻辑，包括 Token 是否过期、AppKey/AppSecret 配置是否正确、Token 存储与刷新机制是否正常，以及该环境（test01）下京东授权是否已完成初始化。如果核实过程中确认属于后端配置或授权流程问题，会明确建议你联系相关开发人员处理。

提示：以上不是最终结论，只是目前能搜索到的信息；完整结论还需要继续补齐证据闭环。`;
assert.equal(
  collapseProgressUpdates(mixedDiagnosticProgress),
  "你提供的 curl、请求参数、Cookie、Header 以及截图中的错误信息已经足够定位问题方向：接口 doSendWuLiuV2 在 wlCompany=jingdong 时，后端调用京东开放平台 API 返回 code=18，即 accessToken=null，属于京东授权 Token 缺失或未正确获取，与你端的登录 Token 无关。",
  "diagnostic conclusion should not be overwritten by trailing progress and incomplete-final notice",
);

assert.equal(
  collapseProgressUpdates(`<agent_progress>
已定位到候选入口，继续核实中。
</agent_progress>

<final_answer>
结论：当前规则不允许切换。
</final_answer>`),
  "结论：当前规则不允许切换。",
  "final_answer tag should override progress content",
);

assert.equal(
  buildProgressStreamContent(`<agent_progress>
已读取需求，继续核实中。
</agent_progress>

<agent_progress>
已定位到 add-mixins.jsx，继续核实中。
</agent_progress>`, ["> 🔍 正在调用: code_snippet..."]),
  "已定位到 add-mixins.jsx，继续核实中。\n\n> 🔍 正在调用: code_snippet...",
  "streaming content should keep latest agent_progress tag and preserve file dots",
);

assert.equal(
  buildProgressStreamContent("<", ["> 🔍 正在调用: query..."]),
  "> 🔍 正在调用: query...",
  "single protocol tag prefix should not be shown before content is available",
);

assert.equal(
  buildProgressStreamContent("<agent_progress", ["> 🔍 正在调用: query..."]),
  "> 🔍 正在调用: query...",
  "non-heartbeat progress should not show processing state when only a tool call is visible",
);

assert.equal(
  collapseProgressUpdates(`<agent_progress>已读取问题，继续核实中。</agent_progress>
未打最终标签的结论：保留现有兜底。`),
  "未打最终标签的结论：保留现有兜底。",
  "fallback content after progress tag should still be available without final_answer",
);

assert.equal(
  collapseProgressUpdates("<agent_progress>已读取问题，继续核实中。"),
  "已读取问题，继续核实中。",
  "incomplete opening protocol tag should not recurse forever",
);

assert.equal(
  collapseProgressUpdates("<agent_progress>已读取问题，继续核实中。\n\n未打最终标签的结论：保留现有兜底。"),
  "未打最终标签的结论：保留现有兜底。",
  "fallback content after incomplete progress tag should still be available",
);

assert.equal(
  buildProgressStreamContent(
    "已读取问题，当前缺少直接证据，继续核实中。\n\n> 🔍 正在调用: query...\n\n已命中候选入口，继续核实中。",
    ["> 🔍 正在调用: code_snippet..."],
  ),
  "已命中候选入口，继续核实中。\n\n> 🔍 正在调用: code_snippet...",
  "streaming content should overwrite old progress and old active tool lines",
);

assert.equal(getProcessingFrame(0), "◐", "processing frame should be deterministic by timestamp");
assert.equal(getProcessingFrame(1000), "◓", "processing frame should rotate to the next heartbeat icon");

assert.equal(
  buildIntermediateStreamContent("已完成问题规划，继续核实中。", 0),
  "◐ 已完成问题规划，继续核实中。",
  "ordinary intermediate stream replies should carry the current processing icon",
);

assert.equal(
  buildIntermediateStreamContent("> 🔍 正在调用: query...", 1000),
  "◓ > 🔍 正在调用: query...",
  "tool-only intermediate stream replies should carry the current processing icon",
);

assert.equal(
  buildIntermediateStreamContent("◐ 处理中：仍在分析中.", 2000),
  "◐ 处理中：仍在分析中.",
  "heartbeat replies should not receive a duplicate processing icon",
);

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。"),
  "已完成问题规划，继续核实中。",
  "non-heartbeat progress should not include processing state",
);

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。", ["> 🔍 正在调用: query..."]),
  "已完成问题规划，继续核实中。\n\n> 🔍 正在调用: query...",
  "non-heartbeat progress with active tool calls should not include processing state",
);

const firstHeartbeat = buildThinkingHeartbeatContent("", [], 0);
const secondHeartbeat = buildThinkingHeartbeatContent("", [], 1000);
assert.notEqual(firstHeartbeat, secondHeartbeat, "thinking heartbeat should change over time");
assert.equal(firstHeartbeat, "◐ 处理中：仍在分析中.", "heartbeat should include dynamic dotted text when no content exists");
assert.equal(secondHeartbeat, "◓ 处理中：仍在核实中..", "heartbeat should rotate text and dots");

assert.equal(
  buildThinkingHeartbeatContent("已完成问题规划，继续核实中。", [], 0),
  "已完成问题规划，继续核实中。\n\n◐ 处理中：仍在分析中.",
  "heartbeat should append dynamic thinking line after latest visible progress",
);

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。\n\n⠋ 处理中：仍在分析中.\n\n结论：可以取消。"),
  "结论：可以取消。",
  "real content should overwrite previous heartbeat dynamic text",
);

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。\n\n⠋ 处理中\n仍在分析中.\n\n结论：可以取消。"),
  "结论：可以取消。",
  "real content should overwrite previous legacy heartbeat dynamic text",
);

const emptyProtocolMarker = "[System: Empty message content sanitised to satisfy protocol]";

assert.equal(
  collapseProgressUpdates(`${emptyProtocolMarker}${emptyProtocolMarker}结论：可以取消。`),
  "结论：可以取消。",
  "empty protocol marker should be removed from collapsed content",
);

assert.equal(
  buildProgressStreamContent(`${emptyProtocolMarker}${emptyProtocolMarker}`, ["> 🔍 正在调用: query..."]),
  "> 🔍 正在调用: query...",
  "streaming progress should not expose empty protocol marker",
);

assert.equal(
  buildThinkingHeartbeatContent(emptyProtocolMarker, [], 0),
  "◐ 处理中：仍在分析中.",
  "thinking heartbeat should not expose empty protocol marker",
);

const adapterSource = readFileSync(new URL("../wecom-adapter.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.doesNotMatch(
  adapterSource,
  /now - lastUpdateTime < THINKING_HEARTBEAT_INTERVAL_MS/,
  "thinking heartbeat should be pushed on its own fixed interval instead of waiting for idle output",
);
const heartbeatStartIndex = adapterSource.indexOf("heartbeatTimer = setInterval");
const agentStreamIndex = adapterSource.indexOf("const stream = await agent.stream");
const finalStopIndex = adapterSource.indexOf("stopThinkingHeartbeat();\n      if (!shouldStopCurrentTask())");
const finalCandidateGuardIndex = adapterSource.indexOf("const hasFinalAnswerCandidate = () => isFinalAnswerReady(collapseProgressUpdates(stripEmptyProtocolContent(fullContent)))");
assert.ok(
  heartbeatStartIndex >= 0 && agentStreamIndex >= 0 && heartbeatStartIndex < agentStreamIndex,
  "thinking heartbeat should start before the agent stream so backend pre/post processing stays alive",
);
assert.ok(
  finalStopIndex > agentStreamIndex,
  "thinking heartbeat should remain active until the final answer is ready to send",
);
assert.ok(
  finalCandidateGuardIndex > 0,
  "adapter should detect final answer candidates before sending more intermediate updates",
);
assert.match(
  adapterSource,
  /const sendStageProgress = async[\s\S]*?if \(hasFinalAnswerCandidate\(\)\) return;/,
  "stage progress should stop once a final answer candidate exists",
);
assert.match(
  adapterSource,
  /heartbeatTimer = setInterval[\s\S]*?if \(hasFinalAnswerCandidate\(\)\) \{\s*stopThinkingHeartbeat\(\);\s*return;\s*\}/,
  "thinking heartbeat should stop once a final answer candidate exists",
);
assert.match(
  adapterSource,
  /!shouldStopCurrentTask\(\) && !hasFinalAnswerCandidate\(\)/,
  "tool status and partial answer pushes should be suppressed after final answer candidate exists",
);

assert.equal(
  collapseProgressUpdates("</think></think></think>已读取第 510-570 行，继续核实中。"),
  "已读取第 510-570 行，继续核实中。",
  "repeated closing think tags should be stripped from visible progress",
);

assert.equal(
  collapseProgressUpdates("<think>内部思考过程不要展示</think>结论：submitFilmYearOrder 调用链路如下。"),
  "结论：submitFilmYearOrder 调用链路如下。",
  "think blocks should be stripped from visible answer",
);

console.log("progress overwrite 验证通过");
