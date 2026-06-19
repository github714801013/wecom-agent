import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBusinessPrompt, resolveBusinessPromptFiles, type PlannerResult } from "../graph.js";

function planner(intent: string, secondary_intents: string[] = []): PlannerResult {
  return {
    intent,
    secondary_intents,
    confidence: 0.9,
    normalized_question: "排查订单没有继续处理的原因",
    business_terms: [],
    code_terms: {
      chinese: [],
      english: [],
      pinyin: [],
      abbr: [],
      mixed: [],
    },
    queries: [],
    hypotheses: [],
    search_plan: {
      primary: [],
      secondary: [],
      exclude: [],
    },
    missing_info: [],
  };
}

const bugFiles = resolveBusinessPromptFiles(planner("BUG"));
assert.deepEqual(
  bugFiles,
  [
    "business-base-prompt.md",
    "categories/troubleshooting-prompt.md",
  ],
  "BUG should load base and troubleshooting prompts only",
);

const apiFiles = resolveBusinessPromptFiles(planner("API"));
assert.deepEqual(
  apiFiles,
  [
    "business-base-prompt.md",
    "categories/troubleshooting-prompt.md",
  ],
  "API should use the troubleshooting prompt",
);

const dedupedFiles = resolveBusinessPromptFiles(planner("BUG", ["API", "CONFIG"]));
assert.deepEqual(
  dedupedFiles,
  [
    "business-base-prompt.md",
    "categories/troubleshooting-prompt.md",
  ],
  "multiple troubleshooting intents should not duplicate prompt files",
);

const sqlFiles = resolveBusinessPromptFiles(planner("SQL"));
assert.deepEqual(
  sqlFiles,
  [
    "business-base-prompt.md",
    "categories/sql-prompt.md",
  ],
  "SQL should load base and SQL prompts only",
);

const flowFiles = resolveBusinessPromptFiles(planner("DOC", ["FLOW"]));
assert.deepEqual(
  flowFiles,
  [
    "business-base-prompt.md",
    "categories/general-prompt.md",
    "categories/flow-prompt.md",
  ],
  "secondary FLOW should add flow prompt after primary category",
);

const bugPrompt = await getBusinessPrompt(planner("BUG"));
assert.match(bugPrompt, /提示词路由：基础规则/, "routed prompt should include base prompt marker");
assert.match(bugPrompt, /提示词路由：排障类问题/, "BUG prompt should include troubleshooting prompt marker");
assert.match(bugPrompt, /把自己当成程序，按代码执行顺序逐层判断/, "BUG prompt should require program-order execution");
assert.match(bugPrompt, /只输出下一跳必要取数语句/, "BUG prompt should request only next-step data query");
assert.doesNotMatch(bugPrompt, /严格禁止输出/, "routed prompt should not load the legacy full business prompt");

const fallbackPrompt = await getBusinessPrompt();
assert.match(fallbackPrompt, /严格禁止输出/, "unclassified fallback should keep legacy full prompt");

const blankIntentFiles = resolveBusinessPromptFiles(planner("   "));
assert.deepEqual(
  blankIntentFiles,
  ["business-prompt.md"],
  "blank intent should fall back to legacy prompt without adding general prompt",
);

const originalCwd = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "wecom-prompt-routing-"));
try {
  await mkdir(join(tempRoot, "src/prompts/categories"), { recursive: true });
  await writeFile(join(tempRoot, "src/prompts/business-base-prompt.md"), "TEMP_BASE_PROMPT", "utf-8");
  await writeFile(join(tempRoot, "src/prompts/business-prompt.md"), "TEMP_LEGACY_PROMPT", "utf-8");
  process.chdir(tempRoot);

  const partialPrompt = await getBusinessPrompt(planner("BUG"));
  assert.match(partialPrompt, /TEMP_BASE_PROMPT/, "partial prompt load should keep loaded base prompt");
  assert.doesNotMatch(partialPrompt, /TEMP_LEGACY_PROMPT/, "single category load failure should not fall back to legacy prompt");
} finally {
  process.chdir(originalCwd);
  await rm(tempRoot, { recursive: true, force: true });
}

const missingRoutedRoot = await mkdtemp(join(tmpdir(), "wecom-prompt-routing-missing-"));
try {
  await mkdir(join(missingRoutedRoot, "src/prompts"), { recursive: true });
  await writeFile(join(missingRoutedRoot, "src/prompts/business-prompt.md"), "TEMP_LEGACY_PROMPT", "utf-8");
  process.chdir(missingRoutedRoot);

  const legacyFallbackPrompt = await getBusinessPrompt(planner("BUG"));
  assert.equal(legacyFallbackPrompt, "TEMP_LEGACY_PROMPT", "all routed prompt load failures should fall back to legacy prompt");
} finally {
  process.chdir(originalCwd);
  await rm(missingRoutedRoot, { recursive: true, force: true });
}

console.log("prompt routing 验证通过");
