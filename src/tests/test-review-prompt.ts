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

console.log("review prompt 审核规则验证通过");
