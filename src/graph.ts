import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAllMcpTools } from "./mcp-client.js";
import { config } from "./config.js";
import { readFile } from "fs/promises";
import { join } from "path";

const MODEL_CONTEXT_MAP: Record<string, number> = {
  "MiniMax-M2.5": 200000,
  "MiniMax-M2.7": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "claude-3-5-sonnet-20240620": 200000,
  "deepseek-v3.2": 64000,
};

export function getModelContextWindow() {
  if (config.LLM_CONTEXT_WINDOW > 0) return config.LLM_CONTEXT_WINDOW;
  
  const modelName = config.LLM_MODEL_NAME;
  const langchainSize = getModelContextSize(modelName);
  
  if (langchainSize !== 4097) {
    return langchainSize;
  }
  
  const mappedSize = MODEL_CONTEXT_MAP[modelName] || 
                     MODEL_CONTEXT_MAP[Object.keys(MODEL_CONTEXT_MAP).find(k => k.toLowerCase() === modelName.toLowerCase()) || ""];
                     
  return mappedSize || 4096;
}

export async function getBaseModel() {
  return new ChatOpenAI({
    modelName: config.LLM_MODEL_NAME,
    apiKey: config.LLM_API_KEY,
    configuration: {
      baseURL: config.LLM_BASE_URL,
    },
    temperature: 0,
  });
}

export async function getPlannerPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/planner-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load planner prompt:", err);
    return "You are a code search planner. Convert user questions to search queries.";
  }
}

export async function getBusinessPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/business-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load business prompt:", err);
    return "You are a professional assistant.";
  }
}

export interface SearchQuery {
  query: string;
  type: string;
  priority: number;
  reason: string;
}

export interface SearchResult {
  id: string;
  source: "mcp" | "gitnexus" | "local";
  query: string;
  type: string;
  content: string;
  file_path?: string;
  symbol?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface CompressorInput {
  user_question: string;
  rewrite_result?: PlannerResult;
  search_results: SearchResult[];
  project_context?: string;
  token_budget?: { target: number; max_per_section: number; mode: string };
}

export interface PlannerResult {
  intent: string;
  secondary_intents: string[];
  confidence: number;
  normalized_question: string;
  business_terms: string[];
  code_terms: {
    chinese: string[];
    english: string[];
    pinyin: string[];
    abbr: string[];
    mixed: string[];
    combined?: string;
    stripped_combined?: string;
  };
  queries: SearchQuery[];
  hypotheses: Array<{
    title: string;
    queries: string[];
  }>;
  search_plan: {
    primary: string[];
    secondary: string[];
    exclude: string[];
  };
  missing_info: string[];
}

export interface CompressorResult {
  status: string;
  intent: string;
  partial: boolean;
  compressed_sections: Array<{
    section_id: string;
    file_path: string;
    symbol: string;
    kind: string;
    lines: string;
    score: number;
    reason: string;
    anchors: string[];
    content: string;
    merged_from: string[];
  }>;
  call_chain: Array<{
    from: string;
    to: string;
    relation: string;
  }>;
  key_evidence: string[];
  dropped: Array<{
    id: string;
    reason: string;
  }>;
  missing_info: string[];
  warnings: string[];
  errors: string[];
  budget: {
    input_est: number;
    output_est: number;
    target: number;
    mode: string;
  };
}

/**
 * 运行 Planner 节点，将用户问题转化为高质量搜索 Query
 */
export async function runPlanner(userQuestion: string): Promise<PlannerResult | null> {
  const model = await getBaseModel();
  const plannerPrompt = await getPlannerPrompt();
  
  const response = await model.invoke([
    new SystemMessage(plannerPrompt),
    new HumanMessage(userQuestion),
  ]);

  try {
    const content = response.content.toString();
    // 简单提取 JSON 部分，防止 LLM 输出多余文字
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
        .replace(/\\n/g, " ") // 处理 JSON 字符串中的换行
        .replace(/\n/g, " ")  // 处理 JSON 外部的换行
        .trim();
      return JSON.parse(jsonStr);
    }
    return null;
  } catch (err) {
    console.error("Failed to parse planner response:", err);
    console.error("Raw response content:", response.content.toString());
    return null;
  }
}

export async function getCompressorPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/compress-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load compressor prompt:", err);
    return "You are a context compressor. Filter and compress code context.";
  }
}

/**
 * 运行 Compressor 节点，压缩检索结果或历史上下文
 */
export async function runCompressor(input: CompressorInput): Promise<CompressorResult | null> {
  const model = await getBaseModel();
  const compressorPrompt = await getCompressorPrompt();

  const response = await model.invoke([
    new SystemMessage(compressorPrompt),
    new HumanMessage(JSON.stringify(input)),
  ]);

  try {
    const content = response.content.toString();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
        .replace(/\\n/g, " ")
        .replace(/\n/g, " ")
        .trim();
      return JSON.parse(jsonStr);
    }
    return null;
  } catch (err) {
    console.error("Failed to parse compressor response:", err);
    console.error("Raw response content:", response.content.toString());
    return null;
  }
}

export interface MinimalSearchLoopOptions {
  planner: (userQuestion: string) => Promise<PlannerResult | null>;
  searcher: (query: SearchQuery) => Promise<SearchResult[]>;
  compressor: (input: CompressorInput) => Promise<CompressorResult | null>;
  nextQueryPlanner: (input: {
    userQuestion: string;
    plannerResult: PlannerResult;
    compression: CompressorResult;
    previousQueries: SearchQuery[];
  }) => Promise<SearchQuery | null>;
  maxIterations?: number;
}

export interface MinimalSearchLoopResult {
  plannerResult: PlannerResult;
  compressions: CompressorResult[];
  executedQueries: SearchQuery[];
  iterations: number;
  complete: boolean;
}

export interface SearchLoopPreludeOptions {
  userQuestion: string;
  plannerResult: PlannerResult;
  tools: any[];
  compressor?: (input: CompressorInput) => Promise<CompressorResult | null>;
  toolIntentResolver?: ToolIntentResolver;
  maxIterations?: number;
}

export interface ToolIntentDecision {
  toolName: string;
  shouldRunPrelude: boolean;
}

export type ToolIntentResolver = (input: {
  userQuestion: string;
  tools: any[];
  searchToolName?: string;
}) => Promise<ToolIntentDecision | null>;

function sortQueriesByKeywordPriority(queries: SearchQuery[]) {
  return [...queries].sort((left, right) => {
    const leftKeywordRank = /keyword|lex|exact/i.test(left.type) ? 0 : 1;
    const rightKeywordRank = /keyword|lex|exact/i.test(right.type) ? 0 : 1;

    return leftKeywordRank - rightKeywordRank || left.priority - right.priority;
  });
}

function getMissingInfo(compression: CompressorResult) {
  return Array.isArray(compression.missing_info)
    ? compression.missing_info.filter(Boolean)
    : [];
}

function hasMissingInfo(compression: CompressorResult) {
  return getMissingInfo(compression).length > 0 || compression.status === "no_hits";
}

function normalizeQueryKey(query: string) {
  return query.trim().toLowerCase();
}

function isValidMaxIterations(maxIterations: number) {
  return Number.isInteger(maxIterations) && maxIterations > 0;
}

export async function runDefaultNextQueryPlanner(input: {
  userQuestion: string;
  plannerResult: PlannerResult;
  compression: CompressorResult;
  previousQueries: SearchQuery[];
}): Promise<SearchQuery | null> {
  const usedQueries = new Set(input.previousQueries.map(query => normalizeQueryKey(query.query)));
  return sortQueriesByKeywordPriority(input.plannerResult.queries)
    .find(query => !usedQueries.has(normalizeQueryKey(query.query))) ?? null;
}

export function createMinimalSearchLoop(options: MinimalSearchLoopOptions) {
  const maxIterations = options.maxIterations ?? 2;

  if (!isValidMaxIterations(maxIterations)) {
    throw new Error("maxIterations must be greater than 0");
  }

  return {
    async run(userQuestion: string): Promise<MinimalSearchLoopResult> {
      const plannerResult = await options.planner(userQuestion);

      if (!plannerResult) {
        throw new Error("Planner did not return a valid search plan");
      }

      const orderedQueries = sortQueriesByKeywordPriority(plannerResult.queries);
      const firstQuery = orderedQueries[0];

      if (!firstQuery) {
        throw new Error("Planner did not return any search query");
      }

      let nextQuery: SearchQuery | null = firstQuery;
      const compressions: CompressorResult[] = [];
      const executedQueries: SearchQuery[] = [];
      const accumulatedSearchResults: SearchResult[] = [];

      for (let iteration = 0; iteration < maxIterations && nextQuery; iteration += 1) {
        if (executedQueries.some(query => normalizeQueryKey(query.query) === normalizeQueryKey(nextQuery!.query))) {
          break;
        }

        const searchResults = await options.searcher(nextQuery);
        accumulatedSearchResults.push(...searchResults);
        executedQueries.push(nextQuery);

        const compression = await options.compressor({
          user_question: userQuestion,
          rewrite_result: plannerResult,
          search_results: accumulatedSearchResults,
          token_budget: {
            target: Math.floor(getModelContextWindow() * 0.2),
            max_per_section: 1000,
            mode: "balanced",
          },
        });

        if (!compression) {
          throw new Error("Compressor did not return a valid result");
        }

        compressions.push(compression);

        if (!hasMissingInfo(compression)) {
          break;
        }

        nextQuery = await options.nextQueryPlanner({
          userQuestion,
          plannerResult,
          compression,
          previousQueries: executedQueries,
        });
      }

      const lastCompression = compressions[compressions.length - 1];

      return {
        plannerResult,
        compressions,
        executedQueries,
        iterations: executedQueries.length,
        complete: Boolean(lastCompression && !hasMissingInfo(lastCompression)),
      };
    },
  };
}

function getToolSchemaKeys(tool: any) {
  const schema = tool?.schema || tool?.input_schema || tool?.inputSchema;
  const shape = schema?.shape;
  if (shape && typeof shape === "object") {
    return Object.keys(shape);
  }

  const properties = schema?.properties || schema?.jsonSchema?.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties);
  }

  return [];
}

function chooseQueryArgName(tool: any) {
  const keys = getToolSchemaKeys(tool);
  return ["query", "searchText", "pattern"].find(key => keys.includes(key));
}

function chooseSearchTool(tools: any[]) {
  return tools.find(tool => chooseQueryArgName(tool) && /query|search|grep|zoekt|gitnexus/i.test(tool.name || ""))
    || tools.find(tool => chooseQueryArgName(tool));
}

function stringifyToolResult(result: unknown) {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function extractFilePath(result: unknown) {
  if (!result || typeof result !== "object") return undefined;
  const item = result as Record<string, unknown>;
  return typeof item.file_path === "string" ? item.file_path
    : typeof item.filePath === "string" ? item.filePath
      : typeof item.path === "string" ? item.path
        : undefined;
}

function formatToolsForIntentResolver(tools: any[]) {
  return tools.map(tool => ({
    name: tool?.name || "unknown",
    description: tool?.description || "",
    inputKeys: getToolSchemaKeys(tool),
  }));
}

function parseToolIntentDecision(content: string): ToolIntentDecision | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.toolName !== "string") return null;
    return {
      toolName: parsed.toolName,
      shouldRunPrelude: Boolean(parsed.shouldRunPrelude),
    };
  } catch {
    return null;
  }
}

async function defaultToolIntentResolver(input: {
  userQuestion: string;
  tools: any[];
  searchToolName?: string;
}): Promise<ToolIntentDecision | null> {
  if (!input.searchToolName) return null;

  const model = await getBaseModel();
  const response = await model.invoke([
    new SystemMessage(`你是 MCP 工具意图路由器。根据用户问题和当前工具列表，判断最应该优先调用哪个工具。

只输出 JSON，不要输出解释。格式：
{"toolName":"工具名","shouldRunPrelude":true或false}

规则：
1. toolName 必须来自工具列表。
2. 只有当最应该优先调用的工具就是 searchToolName 时，shouldRunPrelude 才为 true。
3. 如果用户问题更适合列表、结构、上下文、影响面、数据库或其他专用工具，shouldRunPrelude 必须为 false。`),
    new HumanMessage(JSON.stringify({
      question: input.userQuestion,
      searchToolName: input.searchToolName,
      tools: formatToolsForIntentResolver(input.tools),
    })),
  ]);

  return parseToolIntentDecision(response.content.toString());
}

export function createToolSearchLoopSearcher(tools: any[]) {
  const searchTool = chooseSearchTool(tools);

  return async (query: SearchQuery): Promise<SearchResult[]> => {
    if (!searchTool) return [];

    const queryArgName = chooseQueryArgName(searchTool);
    if (!queryArgName) return [];

    const result = await searchTool.invoke({ [queryArgName]: query.query });
    const searchResult: SearchResult = {
      id: `${searchTool.name || "tool"}:${query.query}`,
      source: /gitnexus/i.test(searchTool.name || "") ? "gitnexus" : "mcp",
      query: query.query,
      type: query.type,
      content: stringifyToolResult(result),
      metadata: {
        tool: searchTool.name || "unknown",
        queryArgName,
      },
    };
    const filePath = extractFilePath(result);
    if (filePath) {
      searchResult.file_path = filePath;
    }
    return [searchResult];
  };
}

export function formatSearchLoopPrelude(loopResult: MinimalSearchLoopResult) {
  const lastCompression = loopResult.compressions[loopResult.compressions.length - 1];
  if (!lastCompression) return "";

  const executedQueries = loopResult.executedQueries
    .map(query => `- ${query.query} (${query.type}, 优先级: ${query.priority})`)
    .join("\n");
  const keyEvidence = lastCompression.key_evidence
    .map(evidence => `- ${evidence}`)
    .join("\n");
  const sections = lastCompression.compressed_sections
    .map(section => `- 文件: ${section.file_path || "未知"}\n  证据: ${section.content}`)
    .join("\n");
  const missingInfo = lastCompression.missing_info.length > 0
    ? lastCompression.missing_info.map(item => `- ${item}`).join("\n")
    : "- 无";

  return `【预检索证据】
已执行查询:
${executedQueries || "- 无"}

关键证据:
${keyEvidence || "- 无"}

压缩代码片段:
${sections || "- 无"}

仍缺少:
${missingInfo}

注意：以上只来自 MCP 预检索工具结果；如证据不足，继续使用工具核实，禁止把“仍缺少”内容直接拼成新的检索词。`;
}

export async function runSearchLoopPrelude(options: SearchLoopPreludeOptions) {
  const searchTool = chooseSearchTool(options.tools);
  const toolIntent = await (options.toolIntentResolver || defaultToolIntentResolver)({
    userQuestion: options.userQuestion,
    tools: options.tools,
    searchToolName: searchTool?.name,
  });

  if (!toolIntent?.shouldRunPrelude || toolIntent.toolName !== searchTool?.name) {
    return "";
  }

  try {
    const loop = createMinimalSearchLoop({
      planner: async () => options.plannerResult,
      searcher: createToolSearchLoopSearcher(options.tools),
      compressor: options.compressor || runCompressor,
      nextQueryPlanner: runDefaultNextQueryPlanner,
      maxIterations: options.maxIterations ?? 2,
    });
    const result = await loop.run(options.userQuestion);
    return formatSearchLoopPrelude(result);
  } catch (err) {
    console.error("Search loop prelude failed:", err);
    return "";
  }
}

export async function initializeAgent(tools?: any[]) {
  const model = await getBaseModel();
  const agentTools = tools || await getAllMcpTools();
  const systemPrompt = await getBusinessPrompt();

  return createAgent({
    model: model,
    tools: agentTools,
    systemPrompt: systemPrompt,
  });
}
