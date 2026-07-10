import { readFile } from "node:fs/promises";
import { join } from "node:path";

function assertIncludes(content: string, expected: string, message: string) {
  if (!content.includes(expected)) {
    throw new Error(`${message}: missing "${expected}"`);
  }
}

const prompt = await readFile(join(process.cwd(), "src/prompts/review-prompt.md"), "utf-8");

assertIncludes(prompt, "只输出 JSON", "review prompt should require strict JSON");
assertIncludes(prompt, "SQL 正确性", "review prompt should audit SQL correctness");
assertIncludes(prompt, "已在 dev 环境对应库执行", "review prompt should require dev SQL validation");
assertIncludes(prompt, "回答准确性", "review prompt should audit answer accuracy");
assertIncludes(prompt, "范围一致性", "review prompt should audit scope consistency");
assertIncludes(prompt, "编码与语义", "review prompt should audit code and meaning output");
assertIncludes(prompt, "needs_correction", "review prompt should support correction status");
assertIncludes(prompt, "needs_human_input", "review prompt should support human input status");
assertIncludes(prompt, "blocked", "review prompt should support blocked status");
assertIncludes(prompt, "correction_instruction", "review prompt should return correction instruction");
assertIncludes(prompt, "继续核实中", "review prompt should reject progress-only final answers");
assertIncludes(prompt, "不是可发送的最终回答", "review prompt should distinguish progress from final answer");
assertIncludes(prompt, "输出完整结论", "review prompt should require a complete final answer");
assertIncludes(prompt, "过程信息与最终形态", "review prompt should audit final answer shape");
assertIncludes(prompt, "简洁易懂", "review prompt should require concise final answers");
assertIncludes(prompt, "结论 + 依据 + 建议/下一步", "review prompt should require compact final structure");
assertIncludes(prompt, "匹配项目和主要入口类名", "review prompt should keep code evidence business-readable");
assertIncludes(prompt, "工具过程、审核清单、TodoList 或自检说明", "review prompt should reject internal process noise");

console.log("review prompt 审核规则验证通过");
