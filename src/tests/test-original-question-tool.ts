import assert from "node:assert/strict";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { buildOriginalQuestionTool } from "../original-question-tool.js";

async function runTest() {
  const tool = buildOriginalQuestionTool({
    originalUserQuestion: "继续",
    currentQuestion: "原问题：submitFilmYearOrder 这个方法调用链路\n用户追问：继续",
    sessionMessages: [
      new HumanMessage("submitFilmYearOrder 这个方法调用链路"),
      new AIMessage("已定位到 ShellFilmServiceImpl.submitFilmYearOrder"),
    ],
  });

  const rawResult = await tool.invoke({});
  const result = JSON.parse(String(rawResult));

  assert.equal(result.original_user_question, "继续");
  assert.equal(result.integrated_user_question, "原问题：submitFilmYearOrder 这个方法调用链路\n用户追问：继续");
  assert.equal(result.current_question, "原问题：submitFilmYearOrder 这个方法调用链路\n用户追问：继续");
  assert.equal(result.session_first_user_question, "submitFilmYearOrder 这个方法调用链路");
  assert.equal(result.has_question_rewrite, true);
  assert.match(tool.name, /original_user_question/);
  assert.match(tool.description, /整合后的用户问题/);

  const plainTool = buildOriginalQuestionTool({
    originalUserQuestion: "常用资产采购单详情 的 历史价 取值逻辑",
    currentQuestion: "常用资产采购单详情 的 历史价 取值逻辑",
    sessionMessages: [],
  });
  const plainResult = JSON.parse(String(await plainTool.invoke({})));
  assert.equal(plainResult.has_question_rewrite, false);
  assert.equal(plainResult.session_first_user_question, "");

  console.log("[SUCCESS] original question tool verified");
}

runTest().catch(error => {
  console.error(error);
  process.exit(1);
});
