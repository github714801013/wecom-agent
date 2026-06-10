import { strict as assert } from "node:assert";
import { buildProgressStreamContent, collapseProgressUpdates, getProcessingFrame } from "../progress-updates.js";

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
  buildProgressStreamContent("<agent_progress", ["> 🔍 正在调用: query..."], { motionFrame: "⠋" }),
  "⠋ 处理中\n> 🔍 正在调用: query...",
  "partial protocol tag prefix should wait instead of showing raw tag text",
);

assert.equal(
  collapseProgressUpdates(`<agent_progress>已读取问题，继续核实中。</agent_progress>
未打最终标签的结论：保留现有兜底。`),
  "未打最终标签的结论：保留现有兜底。",
  "fallback content after progress tag should still be available without final_answer",
);

assert.equal(
  buildProgressStreamContent(
    "已读取问题，当前缺少直接证据，继续核实中。\n\n> 🔍 正在调用: query...\n\n已命中候选入口，继续核实中。",
    ["> 🔍 正在调用: code_snippet..."],
  ),
  "已命中候选入口，继续核实中。\n\n> 🔍 正在调用: code_snippet...",
  "streaming content should overwrite old progress and old active tool lines",
);

assert.equal(getProcessingFrame(0), "⠋", "processing frame should be deterministic by timestamp");

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。", [], { motionFrame: "⠋" }),
  "⠋ 处理中\n已完成问题规划，继续核实中。",
  "streaming content should include a lightweight processing motion frame",
);

assert.equal(
  buildProgressStreamContent("已完成问题规划，继续核实中。", ["> 🔍 正在调用: query..."], { motionFrame: "⠙" }),
  "⠙ 处理中\n已完成问题规划，继续核实中。\n\n> 🔍 正在调用: query...",
  "streaming content should keep motion frame with active tool calls",
);

console.log("progress overwrite 验证通过");
