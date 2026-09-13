import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getBaseModel } from "./graph.js";
import { stringifyModelContent } from "./model-content.js";

const BUSINESS_REWRITE_SYSTEM_PROMPT = `你是一个业务沟通专家。你的任务是将技术性的回答转化为简明扼要的业务语言回复。

规则：
1. 用人类看得懂的语言回答，站在业务角度回复用户
2. 原回答中的 SQL 语句必须完整原样保留：表名、字段名、查询条件、参数值、变量占位符一律不变，不得省略、缩写、改写或截断
3. 原回答中代码的具体取值必须原样保留，不得省略或泛化：字段名、参数名及参数值、枚举值、错误码、状态码、接口路径、配置项及配置值等
4. 除上述必须保留的 SQL 和具体取值外，代码块、代码片段和其余技术实现细节转为业务语言，不要额外输出代码
5. 简明扼要，直接回答用户的问题
6. 保留关键结论和建议，但用业务语言表述
7. 如果原回答包含多个要点，用清晰的列表呈现
8. 保持原回答的核心信息不丢失`;

export async function rewriteAnswerForBusiness(
  question: string,
  answer: string,
): Promise<string> {
  const model = await getBaseModel();
  const response = await model.invoke([
    new SystemMessage(BUSINESS_REWRITE_SYSTEM_PROMPT),
    new HumanMessage(`用户问题：${question}\n\n原始回答：${answer}`),
  ]);
  return stringifyModelContent(response.content);
}
