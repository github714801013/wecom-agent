import { readFile } from "node:fs/promises";
import { join } from "node:path";

function assertIncludes(content: string, expected: string, message: string) {
  if (!content.includes(expected)) {
    throw new Error(`${message}: missing "${expected}"`);
  }
}

function assertNotIncludes(content: string, unexpected: string, message: string) {
  if (content.includes(unexpected)) {
    throw new Error(`${message}: unexpected "${unexpected}"`);
  }
}

const prompt = await readFile(join(process.cwd(), "src/prompts/business-prompt.md"), "utf-8");

assertIncludes(prompt, "已核实接口逻辑", "business prompt should require definite answers when interface logic is verified");
assertIncludes(prompt, "不要使用“可能原因”“最可能原因”", "business prompt should avoid weak headings for verified conclusions");
assertIncludes(prompt, "不确定性只能保留在未核实的枚举含义、外部状态或用户未提供的数据上", "business prompt should scope uncertainty");
assertIncludes(prompt, "代码事实提取类问题", "business prompt should generalize direct code fact extraction");
assertIncludes(prompt, "权限码、按钮编码、配置值、枚举值、接口路径、字段名", "business prompt should cover common direct facts");
assertIncludes(prompt, "直接提取并回答证据中的原值", "business prompt should require extracting values from evidence");
assertIncludes(prompt, "不要把已命中的事实改写成泛化建议", "business prompt should avoid generic advice after direct evidence");
assertIncludes(prompt, "证据不足或证据冲突类问题", "business prompt should handle insufficient or conflicting evidence");
assertIncludes(prompt, "不同问法命中不同候选流程、不同仓库或相反结论", "business prompt should detect inconsistent evidence from query variants");
assertIncludes(prompt, "不得选择看起来更合理的一边作答", "business prompt should forbid guessing between conflicting candidates");
assertIncludes(prompt, "目标范围一致性", "business prompt should require evidence to match the requested project scope");
assertIncludes(prompt, "字段注释不能替代目标项目代码枚举", "business prompt should not answer project enum questions from unrelated db comments");
assertIncludes(prompt, "用户指定项目、端、模块、技术栈、接口、页面或业务入口", "business prompt should generalize project-scoped evidence requirements");
assertIncludes(prompt, "递进式查找", "business prompt should require progressive evidence discovery");
assertIncludes(prompt, "不可或缺条件", "business prompt should distinguish required evidence from auxiliary clues");
assertIncludes(prompt, "候选线索", "business prompt should mark db comments and similar fields as clues only");
assertIncludes(prompt, "直接读写、映射、返回、校验、配置读取或调用链", "business prompt should require binding evidence before answering enum facts");
assertIncludes(prompt, "请补充项目、仓库、入口、页面、单号、环境或业务场景", "business prompt should guide user to refine the question");
assertIncludes(prompt, "明确锚点优先", "business prompt should prefer precise anchors before broad search");
assertIncludes(prompt, "接口路径、接口名、方法名、类名、表名、字段名、配置 key、错误文案", "business prompt should list precise anchor types");
assertIncludes(prompt, "先做精确命中", "business prompt should require exact-match lookup first");
assertIncludes(prompt, "再补充语义扩展", "business prompt should use semantic expansion after exact anchors");
assertIncludes(prompt, "关键操作总结协议", "business prompt should require Claude Code style operation summaries");
assertIncludes(prompt, "一句话状态", "business prompt should require concise one-line operation updates");
assertIncludes(prompt, "继续核实中", "business prompt should indicate when background search continues");
assertIncludes(prompt, "不要使用固定四段模板", "business prompt should avoid verbose four-field templates");
assertIncludes(prompt, "读取需求、GitNexus 检索、代码片段核实、数据库查询、生产 SQL 等待用户执行、测试或部署验证", "business prompt should list key operation summary scenarios");
assertNotIncludes(prompt, "已做：", "business prompt should not use verbose operation summary action field");
assertNotIncludes(prompt, "得到：", "business prompt should not use verbose operation summary evidence field");
assertNotIncludes(prompt, "影响：", "business prompt should not use verbose operation summary impact field");
assertNotIncludes(prompt, "下一步：", "business prompt should not use verbose operation summary next-step field");
assertNotIncludes(prompt, "6e6", "business prompt should not hard-code a single permission value regression example");

console.log("business prompt 肯定结论规则验证通过");
