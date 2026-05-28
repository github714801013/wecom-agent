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
assertIncludes(prompt, "编码语义并列输出", "business prompt should require code and semantic meaning together");
assertIncludes(prompt, "枚举值、常量值、状态值、类型值、数据库字段编码或数字字典值", "business prompt should cover enum constants and database code values");
assertIncludes(prompt, "必须继续核实对应语义", "business prompt should require resolving semantic meaning");
assertIncludes(prompt, "结果必须同时包含编码和值对应的语义", "business prompt should include both code and meaning");
assertIncludes(prompt, "语义未核实时，不得只输出数字或编码", "business prompt should not output code alone when meaning is unknown");
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
assertIncludes(prompt, "追问锚点继承", "business prompt should inherit anchors across follow-up questions");
assertIncludes(prompt, "前文已经确认项目、仓库、接口路径、入口文件、入口方法、类名、方法名或符号", "business prompt should identify prior confirmed anchors");
assertIncludes(prompt, "必须优先带着这些已确认锚点继续查", "business prompt should narrow follow-up searches with prior anchors");
assertIncludes(prompt, "不得重新放宽到其它项目、其它技术栈或宽泛业务词", "business prompt should not broaden follow-up search after anchors exist");
assertIncludes(prompt, "AddOrUpdateV1、/add-or-update/v1、WuLiuController、oa-stock", "business prompt should include representative anchor example");
assertIncludes(prompt, "逻辑梳理流程图规范", "business prompt should require flow diagrams for logic explanations");
assertIncludes(prompt, "企业微信可正常显示的 Markdown 文本流程图", "business prompt should use WeCom-compatible markdown flow diagrams");
assertIncludes(prompt, "不要依赖 Mermaid", "business prompt should avoid Mermaid for WeCom answers");
assertIncludes(prompt, "用缩进、编号、箭头和条件分支表达流程", "business prompt should define compatible flow syntax");
assertIncludes(prompt, "关键操作总结协议", "business prompt should require Claude Code style operation summaries");
assertIncludes(prompt, "一句话状态", "business prompt should require concise one-line operation updates");
assertIncludes(prompt, "继续核实中", "business prompt should indicate when background search continues");
assertIncludes(prompt, "不要使用固定四段模板", "business prompt should avoid verbose four-field templates");
assertIncludes(prompt, "读取需求、GitNexus 检索、代码片段核实、数据库查询、生产 SQL 等待用户执行、测试或部署验证", "business prompt should list key operation summary scenarios");
assertIncludes(prompt, "阶段性进度消息必须覆盖式表达", "business prompt should require overwrite-style progress updates");
assertIncludes(prompt, "不要把多轮检索状态连续追加成一长段", "business prompt should forbid appending many progress updates");
assertIncludes(prompt, "关键入口、接口路径、匹配项目", "business prompt should require key anchors in answers");
assertIncludes(prompt, "仓库或项目、入口文件或入口方法、接口路径或页面路由", "business prompt should require returned matched evidence anchors");
assertNotIncludes(prompt, "已做：", "business prompt should not use verbose operation summary action field");
assertNotIncludes(prompt, "得到：", "business prompt should not use verbose operation summary evidence field");
assertNotIncludes(prompt, "影响：", "business prompt should not use verbose operation summary impact field");
assertNotIncludes(prompt, "下一步：", "business prompt should not use verbose operation summary next-step field");
assertNotIncludes(prompt, "6e6", "business prompt should not hard-code a single permission value regression example");
assertIncludes(prompt, "SQL 输出前验证", "business prompt should require SQL validation before output");
assertIncludes(prompt, "必须先在 dev 环境对应库执行同一条只读查询", "business prompt should require dev database validation");
assertIncludes(prompt, "查询不报错后才允许输出给用户", "business prompt should only output SQL after successful validation");
assertIncludes(prompt, "验证失败时不得输出为已验证 SQL", "business prompt should not claim failed SQL is verified");
assertIncludes(prompt, "生产 SQL 也必须先用 dev 对应库验证结构正确性", "business prompt should validate production SQL structure in dev first");
assertIncludes(prompt, "输出 `prod_sql_required.sql` 前", "business prompt should apply validation to human-loop production SQL");
assertIncludes(prompt, "审核流程节点", "business prompt should define a review workflow node");
assertIncludes(prompt, "最终输出前必须先执行审核流程节点", "business prompt should require review before final output");
assertIncludes(prompt, "审核 SQL 正确性", "business prompt should review SQL correctness");
assertIncludes(prompt, "SQL 是否已经在 dev 环境对应库执行且不报错", "business prompt should verify SQL ran in dev");
assertIncludes(prompt, "审核问题回答准确性", "business prompt should review answer accuracy");
assertIncludes(prompt, "结论是否由已命中的项目、接口、入口、代码片段、数据库结果或用户补充支撑", "business prompt should verify answer evidence");
assertIncludes(prompt, "验收阶段必须核对编码语义并列输出", "business prompt should review code meaning output during acceptance");
assertIncludes(prompt, "涉及枚举值、常量值、状态值、类型值、数据库字段编码或数字字典值时", "business prompt should apply acceptance review to all code-like values");
assertIncludes(prompt, "最终答案是否同时包含编码和值对应的语义", "business prompt should verify final answer includes code and meaning");
assertIncludes(prompt, "审核不通过时不得输出最终结论", "business prompt should block final answer when review fails");
assertIncludes(prompt, "截图信息提取规则", "business prompt should define screenshot extraction rules");
assertIncludes(prompt, "优先识别截图中的 URL 地址", "business prompt should prioritize screenshot URLs");
assertIncludes(prompt, "与问题直接相关的页面文案、按钮文案、错误提示、弹窗文案、字段标签和表格列名", "business prompt should prioritize problem-related screenshot text");
assertIncludes(prompt, "不要只按用户转述提问", "business prompt should not ignore screenshot evidence");
assertIncludes(prompt, "截图中的 URL 和关键文案应作为明确锚点", "business prompt should use screenshot evidence as anchors");

console.log("business prompt 肯定结论规则验证通过");
