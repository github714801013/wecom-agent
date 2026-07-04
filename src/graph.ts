import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { getAllMcpTools } from "./mcp-client.js";
import { config } from "./config.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { buildRelationshipIndex, formatRelationshipIndex } from "./relationship-index.js";
import { buildAnalyzedCodeRangeIndex, formatAnalyzedCodeRangeIndex } from "./analyzed-code-range-index.js";
import { PROGRESS_KEYWORDS } from "./progress-updates.js";
import { createReactLoopController, wrapToolsWithReactLoopControl } from "./react-loop-control.js";

const MODEL_CONTEXT_MAP: Record<string, number> = {
  "MiniMax-M2.5": 200000,
  "MiniMax-M2.7": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "claude-3-5-sonnet-20240620": 200000,
  "deepseek-v3.2": 64000,
};

export function getModelContextWindow() {
  if (config.llm.contextWindow > 0) return config.llm.contextWindow;
  
  const modelName = config.llm.modelName;
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
    modelName: config.llm.modelName,
    apiKey: config.llm.apiKey,
    configuration: {
      baseURL: config.llm.baseUrl,
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

type BusinessPromptPlanner = Pick<PlannerResult, "intent" | "secondary_intents">;

const LEGACY_BUSINESS_PROMPT_FILE = "business-prompt.md";
const BASE_BUSINESS_PROMPT_FILE = "business-base-prompt.md";
const GENERAL_CATEGORY_PROMPT_FILE = "categories/general-prompt.md";
const FLOW_CATEGORY_PROMPT_FILE = "categories/flow-prompt.md";
const SQL_CATEGORY_PROMPT_FILE = "categories/sql-prompt.md";
const TROUBLESHOOTING_CATEGORY_PROMPT_FILE = "categories/troubleshooting-prompt.md";

const TROUBLESHOOTING_INTENTS = new Set(["BUG", "API", "CONFIG", "DEPLOY", "PERF"]);
const DIRECT_INTENT_PROMPT_FILES = new Map([
  ["SQL", SQL_CATEGORY_PROMPT_FILE],
  ["FLOW", FLOW_CATEGORY_PROMPT_FILE],
]);
const KNOWN_DIRECT_INTENTS = new Set(DIRECT_INTENT_PROMPT_FILES.keys());
const ALL_KNOWN_INTENTS = new Set([...TROUBLESHOOTING_INTENTS, ...KNOWN_DIRECT_INTENTS]);

function normalizeIntent(intent: string) {
  return intent.trim().toUpperCase();
}

function addPromptFile(files: string[], file: string) {
  if (!files.includes(file)) files.push(file);
}

function resolveCategoryPromptFile(intent: string) {
  if (TROUBLESHOOTING_INTENTS.has(intent)) return TROUBLESHOOTING_CATEGORY_PROMPT_FILE;
  const directPromptFile = DIRECT_INTENT_PROMPT_FILES.get(intent);
  if (directPromptFile) return directPromptFile;
  if (!ALL_KNOWN_INTENTS.has(intent)) {
    console.warn(`[PromptRouter] Unrecognized intent '${intent}', falling back to general prompt`);
  }
  return GENERAL_CATEGORY_PROMPT_FILE;
}

export function resolveBusinessPromptFiles(plannerResult?: BusinessPromptPlanner | null) {
  if (!plannerResult?.intent) return [LEGACY_BUSINESS_PROMPT_FILE];

  const intents = [
    plannerResult.intent,
    ...(plannerResult.secondary_intents || []),
  ]
    .filter(Boolean)
    .map(normalizeIntent)
    .filter(Boolean);

  if (intents.length === 0) return [LEGACY_BUSINESS_PROMPT_FILE];

  const files = [BASE_BUSINESS_PROMPT_FILE];
  for (const intent of intents) {
    addPromptFile(files, resolveCategoryPromptFile(intent));
  }
  return files;
}

async function readBusinessPromptFile(relativePath: string) {
  return readFile(join(process.cwd(), "src/prompts", relativePath), "utf-8");
}

export async function getBusinessPrompt(plannerResult?: BusinessPromptPlanner | null) {
  const promptFiles = resolveBusinessPromptFiles(plannerResult);
  const results = await Promise.allSettled(promptFiles.map(readBusinessPromptFile));
  const loadedPrompts: string[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      loadedPrompts.push(result.value);
    } else {
      console.error(`Failed to load business prompt file ${promptFiles[index] || "unknown"}:`, result.reason);
    }
  }

  if (loadedPrompts.length > 0) {
    return loadedPrompts.join("\n\n");
  }

  if (promptFiles.includes(LEGACY_BUSINESS_PROMPT_FILE)) {
    return "You are a professional assistant.";
  }

  try {
    console.warn("Routed business prompt files failed to load; falling back to legacy business prompt.");
    return await readBusinessPromptFile(LEGACY_BUSINESS_PROMPT_FILE);
  } catch {
    return "You are a professional assistant.";
  }
}

export async function getReviewPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/review-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load review prompt:", err);
    return "You are an answer reviewer. Output strict JSON.";
  }
}

export type AnswerReviewStatus = "passed" | "needs_correction" | "needs_human_input" | "blocked";

export interface AnswerReviewResult {
  passed: boolean;
  status: AnswerReviewStatus;
  reason: string;
  issues: string[];
  correction_instruction: string;
}

export interface ReviewedAgentOptions {
  reviewer?: (input: {
    messages: BaseMessage[];
    answer: string;
    round: number;
  }) => Promise<AnswerReviewResult>;
  maxReviewRounds?: number;
  reviewDeadlineMs?: number;
  now?: () => number;
}

const INCOMPLETE_PROGRESS_PATTERNS = [...PROGRESS_KEYWORDS];

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
  repoHint?: string | string[] | undefined;
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

    return left.priority - right.priority || leftKeywordRank - rightKeywordRank;
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

function isGitNexusQueryTool(tool: any) {
  const keys = getToolSchemaKeys(tool);
  return tool?.name === "query"
    && keys.includes("query")
    && keys.includes("zoekt")
    && keys.includes("repo")
    && keys.includes("max_symbols");
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

const PROJECT_SELECTION_MARKER_PATTERN = /项目|仓库|代码包|模块|repo|只查|在|从/iu;

const PROJECT_PREFIX_ALIASES: Record<string, string[]> = {
  iteng: ["易腾", "iteng"],
  yiteng: ["易腾", "yiteng"],
  jxy: ["九讯云", "九讯", "jxy"],
  jiuyun: ["九讯云", "九讯", "jiuyun"],
};

type RepoCandidate = {
  repo: string;
  latestIndex: number;
  firstIndex: number;
};

type RepoCandidateMatch = RepoCandidate & {
  score: number;
  variantScore: number;
};

function splitProjectHeaderValue(value: unknown) {
  return typeof value === "string"
    ? value.split(",").map(project => project.trim()).filter(Boolean)
    : [];
}

function uniqueRepoCandidatesWithLatest(repoCandidates: string[]) {
  const byLower = new Map<string, { repo: string; latestIndex: number; firstIndex: number }>();
  repoCandidates.forEach((candidate, index) => {
    const repo = candidate.trim();
    if (!repo) return;
    const key = repo.toLowerCase();
    const existing = byLower.get(key);
    byLower.set(key, {
      repo,
      latestIndex: index,
      firstIndex: existing?.firstIndex ?? index,
    });
  });
  return Array.from(byLower.values());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRepoBoundaryPattern(repo: string) {
  const escaped = escapeRegExp(repo);
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:[\\\\/]|\\b|[^A-Za-z0-9_.-]|$)`, "i");
}

function buildRepoPathAnchorPattern(repo: string) {
  const escaped = escapeRegExp(repo);
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}\\s*[\\\\/]`, "i");
}

function normalizeRepoKey(repo: string) {
  return repo.trim().toLowerCase();
}

function isRepoVariantOf(candidateRepo: string, baseRepo: string) {
  const candidate = normalizeRepoKey(candidateRepo);
  const base = normalizeRepoKey(baseRepo);
  return candidate === base || candidate.endsWith(`-${base}`) || candidate.endsWith(`_${base}`);
}

function getRepoPrefixTerms(repo: string, allCandidates: RepoCandidate[]) {
  const lowerRepo = normalizeRepoKey(repo);
  const terms = new Set<string>();

  for (const candidate of allCandidates) {
    const base = normalizeRepoKey(candidate.repo);
    if (base === lowerRepo) continue;
    if (lowerRepo.endsWith(`-${base}`) || lowerRepo.endsWith(`_${base}`)) {
      const prefix = lowerRepo.slice(0, lowerRepo.length - base.length).replace(/[-_]+$/g, "");
      prefix.split(/[-_]+/).filter(Boolean).forEach(term => terms.add(term));
    }
  }

  lowerRepo.split(/[-_]+/).slice(0, -1).filter(Boolean).forEach(term => terms.add(term));
  return Array.from(terms);
}

function calculateRepoVariantScore(userQuestion: string, repo: string, allCandidates: RepoCandidate[]) {
  const lowerQuestion = userQuestion.toLowerCase();
  return getRepoPrefixTerms(repo, allCandidates).reduce((score, term) => {
    const aliases = PROJECT_PREFIX_ALIASES[term] ?? [];
    return aliases.some(alias => lowerQuestion.includes(alias.toLowerCase()))
      ? score + 500
      : score;
  }, 0);
}

export function extractMcpProjectCandidates(mcpServers: any[] = []) {
  const projectNames = mcpServers.flatMap(server => [
    ...splitProjectHeaderValue(server?.headers?.projects),
    ...Object.values(server?.headerProfiles ?? {}).flatMap((profile: any) => splitProjectHeaderValue(profile?.projects)),
  ]);

  return uniqueRepoCandidatesWithLatest(projectNames).map(candidate => candidate.repo);
}

export function extractExplicitRepoHints(userQuestion: string, repoCandidates: string[] = []) {
  const candidates = uniqueRepoCandidatesWithLatest(repoCandidates);
  if (candidates.length === 0) return [];

  const explicitRepoPattern = /(?:只查|在|从|某项目|某仓库|项目|仓库|repo)\s*([A-Za-z0-9_.\-/，,、和及与\s]+)|([A-Za-z0-9_.\-/]+)\s*(?:项目|仓库|repo)/gi;
  const explicitMatchKeys = new Set(Array.from(userQuestion.matchAll(explicitRepoPattern))
    .flatMap(match => (match[1] || match[2] || "").split(/[，,、和及与\s]+/))
    .map(match => match.trim().toLowerCase())
    .filter(Boolean));
  const allowSemanticMatch = PROJECT_SELECTION_MARKER_PATTERN.test(userQuestion);

  const matches = candidates
    .map(candidate => {
      const key = normalizeRepoKey(candidate.repo);
      const hasExplicitMatch = explicitMatchKeys.has(key);
      const hasVariantMatch = Array.from(explicitMatchKeys).some(explicitKey => isRepoVariantOf(candidate.repo, explicitKey));
      const boundaryScore = buildRepoBoundaryPattern(candidate.repo).test(userQuestion) ? 300 : 0;
      const pathScore = buildRepoPathAnchorPattern(candidate.repo).test(userQuestion) ? 300 : 0;
      const explicitScore = hasExplicitMatch ? 600 : hasVariantMatch ? 500 : 0;
      const variantScore = calculateRepoVariantScore(userQuestion, candidate.repo, candidates);
      const score = explicitScore + boundaryScore + pathScore;
      return { ...candidate, score, variantScore };
    })
    .filter((match): match is RepoCandidateMatch => {
      const matchedByRepo = match.score > 0 && (allowSemanticMatch || buildRepoPathAnchorPattern(match.repo).test(userQuestion));
      return matchedByRepo || match.variantScore > 0;
    });

  return matches
    .sort((left, right) => {
      const totalDiff = (right.score + right.variantScore) - (left.score + left.variantScore);
      if (totalDiff !== 0) return totalDiff;
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) return scoreDiff;
      const sameProjectVariant = isRepoVariantOf(left.repo, right.repo) || isRepoVariantOf(right.repo, left.repo);
      return sameProjectVariant
        ? right.latestIndex - left.latestIndex || left.firstIndex - right.firstIndex
        : left.firstIndex - right.firstIndex;
    })
    .map(match => match.repo);
}

export function extractExplicitRepoHint(userQuestion: string, repoCandidates: string[] = []) {
  return extractExplicitRepoHints(userQuestion, repoCandidates)[0] ?? null;
}

function mergeScopedToolResults(results: unknown[], repoHints: string[]) {
  return results.length === 1
    ? results[0]
    : results.map((result, index) => ({ repo: repoHints[index], result }));
}

function shouldScopeToolToRepo(tool: any) {
  return Boolean(
    chooseQueryArgName(tool)
    && /query|search|zoekt|gitnexus/i.test(tool?.name || "")
  );
}

export function scopeToolsToRepo(tools: any[], repoHint?: string | string[]) {
  const repoHints = Array.isArray(repoHint) ? repoHint.filter(Boolean) : repoHint ? [repoHint] : [];
  if (repoHints.length === 0) return tools;

  return tools.map(tool => {
    if (!shouldScopeToolToRepo(tool) || typeof tool?.invoke !== "function") {
      return tool;
    }

    const scopedTool = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
    const invoke = tool.invoke.bind(tool);
    scopedTool.invoke = async (args: any, ...rest: any[]) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return invoke(args, ...rest);
      }

      const results = await Promise.all(repoHints.map(repo => {
        const queryValue = args.query ?? args.searchText ?? args.pattern;
        console.log("[GitNexus Scope]", JSON.stringify({
          tool: tool.name || "unknown",
          repo,
          queryLength: typeof queryValue === "string" ? queryValue.length : 0,
        }));
        return invoke({ ...args, repo }, ...rest);
      }));
      return mergeScopedToolResults(results, repoHints);
    };
    return scopedTool;
  });
}

export function createToolSearchLoopSearcher(tools: any[], repoHint?: string | string[]) {
  const scopedTools = scopeToolsToRepo(tools, repoHint);
  const searchTool = chooseSearchTool(scopedTools);

  return async (query: SearchQuery): Promise<SearchResult[]> => {
    if (!searchTool) return [];

    const queryArgName = chooseQueryArgName(searchTool);
    if (!queryArgName) return [];

    const keys = getToolSchemaKeys(searchTool);
    const repoHints = Array.isArray(repoHint) ? repoHint.filter(Boolean) : repoHint ? [repoHint] : [];
    const args = repoHints.length > 0 && keys.includes("repo")
      ? { [queryArgName]: query.query, repo: repoHints[0] }
      : { [queryArgName]: query.query };
    const result = await searchTool.invoke(args);
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
  const relationshipIndex = formatRelationshipIndex(
    buildRelationshipIndex({
      callChain: lastCompression.call_chain,
      texts: [
        ...lastCompression.key_evidence,
        ...lastCompression.compressed_sections.map(section => section.content),
      ],
    }),
  );
  const analyzedCodeRangeIndex = formatAnalyzedCodeRangeIndex(
    buildAnalyzedCodeRangeIndex({
      sections: lastCompression.compressed_sections,
      texts: [
        ...lastCompression.key_evidence,
        ...lastCompression.compressed_sections.map(section => section.content),
      ],
    }),
  );
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

关系索引:
${relationshipIndex}

已分析代码范围索引:
${analyzedCodeRangeIndex}

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

  if (isGitNexusQueryTool(searchTool)) {
    console.log("[Search Loop Prelude] Skip GitNexus query prelude to avoid duplicate vector search.");
    return "";
  }

  try {
    const loop = createMinimalSearchLoop({
      planner: async () => options.plannerResult,
      searcher: createToolSearchLoopSearcher(options.tools, options.repoHint),
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

export function buildMessagesForCurrentTurn(input: {
  sessionMessages: BaseMessage[];
  userContent: any;
  repoHint?: string | string[] | undefined;
}) {
  return [
    ...compactSessionMessagesForGoal(input.sessionMessages, stringifyMessageContent(input.userContent), input.repoHint),
    new HumanMessage({ content: input.userContent }),
  ];
}

const MAX_GOAL_RELEVANT_SESSION_MESSAGES = 4;
const MAX_COMPACT_SESSION_MESSAGE_LENGTH = 700;
const STRONG_GOAL_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_$]{2,}|[\u4e00-\u9fa5]{2,}|\/[A-Za-z0-9/_{}.-]+/g;
const NOISY_SESSION_MARKERS = [
  "继续核实中",
  "正在调用",
  "处理中",
  "已读取第",
  "已定位候选",
];
const GENERIC_GOAL_TOKENS = new Set([
  "只查",
  "方法",
  "调用",
  "链路",
  "调用链路",
  "来源",
  "逻辑",
  "这个",
  "问题",
  "当前",
  "分析",
  "查看",
  "查询",
]);

function truncateForGoalContext(text: string) {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= MAX_COMPACT_SESSION_MESSAGE_LENGTH) return compacted;
  return `${compacted.slice(0, MAX_COMPACT_SESSION_MESSAGE_LENGTH)}...`;
}

function extractGoalTokens(text: string, repoHint?: string | string[]) {
  const repoHints = Array.isArray(repoHint) ? repoHint : repoHint ? [repoHint] : [];
  const tokens = [
    ...repoHints,
    ...Array.from(text.matchAll(STRONG_GOAL_TOKEN_PATTERN)).map(match => match[0]),
  ]
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !GENERIC_GOAL_TOKENS.has(token))
    .filter(token => !NOISY_SESSION_MARKERS.some(marker => token.includes(marker)));

  return Array.from(new Set(tokens)).slice(0, 80);
}

function isGoalRelevantSessionMessage(message: BaseMessage, goalTokens: string[]) {
  const type = (message as any)._getType?.() || message.constructor.name;
  const content = stringifyMessageContent(message.content);
  if (!content.trim()) return false;
  if (content.includes("短时记忆图") || content.includes("已确认锚点清单")) return true;
  return goalTokens.some(token => content.includes(token));
}

function buildSelectedSessionRelationshipIndex(messages: BaseMessage[], userContent: string) {
  return formatRelationshipIndex(
    buildRelationshipIndex({
      texts: [
        userContent,
        ...messages.map(message => stringifyMessageContent(message.content)),
      ],
      maxEdges: 10,
    }),
    "- 暂无明确关系索引；请优先沿当前问题锚点继续核实，不要用被剔除历史反推结论。",
  );
}

function buildSelectedSessionAnalyzedCodeRangeIndex(messages: BaseMessage[], userContent: string) {
  return formatAnalyzedCodeRangeIndex(
    buildAnalyzedCodeRangeIndex({
      texts: [
        userContent,
        ...messages.map(message => stringifyMessageContent(message.content)),
      ],
      maxRanges: 12,
    }),
    "- 暂无明确已分析代码范围索引；如需继续读取代码，优先避开已确认范围。",
  );
}

export function compactSessionMessagesForGoal(
  sessionMessages: BaseMessage[],
  userContent: string,
  repoHint?: string | string[] | undefined,
) {
  if (sessionMessages.length === 0) return [];

  const goalTokens = extractGoalTokens(userContent, repoHint);
  const selected = new Set<BaseMessage>();
  for (const message of sessionMessages) {
    if (isGoalRelevantSessionMessage(message, goalTokens)) {
      selected.add(message);
    }
  }

  const compacted = sessionMessages
    .filter(message => selected.has(message))
    .slice(-MAX_GOAL_RELEVANT_SESSION_MESSAGES)
    .map(message => {
      const content = stringifyMessageContent(message.content);
      if (content.length <= MAX_COMPACT_SESSION_MESSAGE_LENGTH) return message;
      if (message instanceof HumanMessage) return new HumanMessage({ content: truncateForGoalContext(content) });
      if (message instanceof AIMessage) return new AIMessage(truncateForGoalContext(content));
      return new SystemMessage(truncateForGoalContext(content));
    });

  if (compacted.length < sessionMessages.length) {
    const removed = sessionMessages.length - compacted.length;
    const relationshipIndex = buildSelectedSessionRelationshipIndex(compacted, userContent);
    const analyzedCodeRangeIndex = buildSelectedSessionAnalyzedCodeRangeIndex(compacted, userContent);
    return [
      new SystemMessage(`【当前目标上下文精简】已剔除 ${removed} 条与当前目标弱相关的历史消息，仅保留少量命中锚点内容。完整历史、已确认锚点、调用关系和已分析代码范围已通过 session_memory_graph_query 按需查询；遇到“继续/追问/继承上一轮锚点/避免重复读取代码”时必须先调用该工具。

【关系索引】
${relationshipIndex}

【已分析代码范围索引】
${analyzedCodeRangeIndex}`),
      ...compacted,
    ];
  }

  return compacted;
}

export function getConfiguredMaxReviewRounds() {
  const rawValue = process.env.ANSWER_REVIEW_MAX_ROUNDS;
  if (!rawValue) return 2;

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) return 2;
  return Math.min(parsed, 5);
}

function stringifyMessageContent(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function normalizeReviewStatus(status: unknown, passed: boolean): AnswerReviewStatus {
  if (status === "passed" || status === "needs_correction" || status === "needs_human_input" || status === "blocked") {
    return status;
  }
  return passed ? "passed" : "needs_correction";
}

export function parseAnswerReviewResult(content: string): AnswerReviewResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      passed: false,
      status: "needs_correction",
      reason: "审核节点未返回有效 JSON",
      issues: ["审核节点输出格式无效"],
      correction_instruction: "重新核对上一版回答，补齐证据后按要求输出最终答案；如证据不足，转为要求用户补充信息。",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const passed = Boolean(parsed.passed);
    const status = normalizeReviewStatus(parsed.status, passed);
    return {
      passed: passed && status === "passed",
      status,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).filter(Boolean) : [],
      correction_instruction: typeof parsed.correction_instruction === "string" ? parsed.correction_instruction : "",
    };
  } catch {
    return {
      passed: false,
      status: "needs_correction",
      reason: "审核节点 JSON 解析失败",
      issues: ["审核节点输出不是合法 JSON"],
      correction_instruction: "重新核对上一版回答，补齐证据后按要求输出最终答案；如证据不足，转为要求用户补充信息。",
    };
  }
}

export async function runAnswerReview(input: {
  messages: BaseMessage[];
  answer: string;
  round: number;
}): Promise<AnswerReviewResult> {
  const model = await getBaseModel();
  const reviewPrompt = await getReviewPrompt();
  const response = await model.invoke([
    new SystemMessage(reviewPrompt),
    new HumanMessage(JSON.stringify({
      round: input.round,
      conversation: input.messages.map(message => ({
        type: (message as any)._getType?.() || message.constructor.name,
        content: stringifyMessageContent(message.content),
      })),
      answer: input.answer,
    })),
  ]);

  return parseAnswerReviewResult(response.content.toString());
}

export function buildReviewCorrectionMessage(review: AnswerReviewResult) {
  return new HumanMessage(`【回答审核未通过】
审核状态：${review.status}
审核原因：${review.reason || "未提供"}
问题清单：
${review.issues.length > 0 ? review.issues.map(issue => `- ${issue}`).join("\n") : "- 未提供"}

纠正要求：
${review.correction_instruction || "请重新核对证据并修正回答。"}

请基于以上审核意见继续处理上一轮问题。若问题本身缺少关键信息、需要生产查询结果或遇到工具/环境阻塞，不要猜测，改为明确要求用户补充或说明阻塞。`);
}

function collectAnswerContent(current: string, message: BaseMessage) {
  const type = (message as any)._getType?.() || message.constructor.name;
  if (!(type === "ai" || type === "AIMessage" || type === "AIMessageChunk")) {
    return current;
  }

  const aiMsg = message as any;
  if ((aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) || (aiMsg.tool_calls && aiMsg.tool_calls.length > 0)) {
    return current;
  }

  const delta = stringifyMessageContent(aiMsg.content);
  if (!delta) return current;
  return current && delta.startsWith(current) ? delta : current + delta;
}

function isAnswerContentMessage(message: BaseMessage) {
  const type = (message as any)._getType?.() || message.constructor.name;
  if (!(type === "ai" || type === "AIMessage" || type === "AIMessageChunk")) {
    return false;
  }

  const aiMsg = message as any;
  if ((aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) || (aiMsg.tool_calls && aiMsg.tool_calls.length > 0)) {
    return false;
  }

  return Boolean(stringifyMessageContent(aiMsg.content));
}

const PROGRESS_END_PATTERN = new RegExp(
  `(?:${PROGRESS_KEYWORDS.map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[。.!！\\s]*$`,
  "u",
);

export function enforceFinalAnswerCompleteness(review: AnswerReviewResult, answer: string): AnswerReviewResult {
  const normalizedAnswer = answer.trim();
  const hasIncompleteProgress = INCOMPLETE_PROGRESS_PATTERNS.some(pattern => normalizedAnswer.includes(pattern));
  const endsAsProgress = PROGRESS_END_PATTERN.test(normalizedAnswer);

  if (!hasIncompleteProgress || !endsAsProgress) {
    return review;
  }

  return {
    passed: false,
    status: "needs_correction",
    reason: "最终回答仍停留在阶段性进度，缺少完整结论",
    issues: [
      "回答包含阶段性进度句",
      "回答没有形成可发送的最终业务结论",
    ],
    correction_instruction: "继续完成核实后输出完整回答；必须包含支持的支付方式、判断依据、入口/接口/项目定位信息。若证据不足，改为 Human Loop 说明缺少的最小信息。",
  };
}

export function createReviewedAgent(baseAgent: any, options: ReviewedAgentOptions = {}) {
  return {
    async *stream(input: { messages: BaseMessage[] }, config?: Record<string, unknown>) {
      const stream = await baseAgent.stream(input, config);
      for await (const item of stream) {
        yield item;
      }
    },
  };
}

export async function initializeAgent(tools?: any[], plannerResult?: BusinessPromptPlanner | null) {
  const model = await getBaseModel();
  const agentTools = tools || await getAllMcpTools();
  const reactLoopController = createReactLoopController();
  const controlledTools = wrapToolsWithReactLoopControl(agentTools, reactLoopController);
  const systemPrompt = await getBusinessPrompt(plannerResult);

  const baseAgent = createAgent({
    model: model,
    tools: controlledTools,
    systemPrompt: systemPrompt,
  });

  return createReviewedAgent(baseAgent);
}
