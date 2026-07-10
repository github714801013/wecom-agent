export type AgenticRagNode = "plan" | "retrieve" | "grade" | "rewrite" | "complete" | "stop";

export type AgenticRagStopReason =
  | "evidence_sufficient"
  | "no_queries"
  | "max_iterations"
  | "max_rewrites"
  | "duplicate_query"
  | "empty_rewrite";

export interface AgenticRagQuery {
  query: string;
  type: string;
  priority: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface AgenticRagEvidence {
  id: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface AgenticRagGrade {
  relevant: boolean;
  sufficient: boolean;
  reason: string;
  missingInfo: string[];
}

export interface AgenticRagTraceItem {
  node: AgenticRagNode;
  iteration: number;
  query?: string;
  evidenceCount: number;
  detail: string;
}

export interface AgenticRagContext<Q extends AgenticRagQuery, E extends AgenticRagEvidence> {
  question: string;
  currentQuery: Q;
  evidence: E[];
  executedQueries: Q[];
  iteration: number;
}

export interface AgenticRagGradeInput<Q extends AgenticRagQuery, E extends AgenticRagEvidence>
  extends AgenticRagContext<Q, E> {
  latestEvidence: E[];
}

export interface AgenticRagRewriteInput<Q extends AgenticRagQuery, E extends AgenticRagEvidence> {
  question: string;
  grade: AgenticRagGrade;
  evidence: E[];
  executedQueries: Q[];
  rewriteCount: number;
}

export interface AgenticRagOptions<Q extends AgenticRagQuery, E extends AgenticRagEvidence> {
  question: string;
  queries: Q[];
  retrieve: (query: Q, context: AgenticRagContext<Q, E>) => Promise<E[]>;
  grade: (input: AgenticRagGradeInput<Q, E>) => Promise<AgenticRagGrade>;
  rewrite?: (input: AgenticRagRewriteInput<Q, E>) => Promise<Q | null>;
  maxIterations?: number;
  maxRewrites?: number;
}

export interface AgenticRagResult<Q extends AgenticRagQuery, E extends AgenticRagEvidence> {
  complete: boolean;
  stopReason: AgenticRagStopReason;
  iterations: number;
  evidence: E[];
  executedQueries: Q[];
  rewrittenQueries: Q[];
  grades: AgenticRagGrade[];
  trace: AgenticRagTraceItem[];
}

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MAX_REWRITES = 1;

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function normalizeAgenticRagQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeEvidenceContent(content: string) {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function sortQueries<Q extends AgenticRagQuery>(queries: Q[]) {
  return queries
    .map((query, index) => ({ query, index }))
    .sort((left, right) => {
      const leftPriority = Number.isFinite(left.query.priority) ? left.query.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = Number.isFinite(right.query.priority) ? right.query.priority : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(item => item.query);
}

function takeNextUnusedQuery<Q extends AgenticRagQuery>(queue: Q[], usedQueryKeys: Set<string>) {
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    const queryKey = normalizeAgenticRagQuery(candidate.query);
    if (queryKey && !usedQueryKeys.has(queryKey)) {
      return candidate;
    }
  }
  return null;
}

function appendUniqueEvidence<E extends AgenticRagEvidence>(input: {
  target: E[];
  incoming: E[];
  seenIds: Set<string>;
  seenContents: Set<string>;
}) {
  const appended: E[] = [];

  for (const item of input.incoming) {
    const idKey = item.id.trim();
    const contentKey = normalizeEvidenceContent(item.content);
    const duplicateById = Boolean(idKey && input.seenIds.has(idKey));
    const duplicateByContent = Boolean(contentKey && input.seenContents.has(contentKey));

    if (duplicateById || duplicateByContent) {
      continue;
    }

    input.target.push(item);
    appended.push(item);
    if (idKey) input.seenIds.add(idKey);
    if (contentKey) input.seenContents.add(contentKey);
  }

  return appended;
}

function createTraceItem(input: Omit<AgenticRagTraceItem, "evidenceCount"> & { evidenceCount: number }) {
  return input;
}

function createResult<Q extends AgenticRagQuery, E extends AgenticRagEvidence>(input: {
  complete: boolean;
  stopReason: AgenticRagStopReason;
  evidence: E[];
  executedQueries: Q[];
  rewrittenQueries: Q[];
  grades: AgenticRagGrade[];
  trace: AgenticRagTraceItem[];
}): AgenticRagResult<Q, E> {
  return {
    complete: input.complete,
    stopReason: input.stopReason,
    iterations: input.executedQueries.length,
    evidence: [...input.evidence],
    executedQueries: [...input.executedQueries],
    rewrittenQueries: [...input.rewrittenQueries],
    grades: [...input.grades],
    trace: [...input.trace],
  };
}

export async function runAgenticRag<Q extends AgenticRagQuery, E extends AgenticRagEvidence>(
  options: AgenticRagOptions<Q, E>,
): Promise<AgenticRagResult<Q, E>> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxRewrites = options.maxRewrites ?? DEFAULT_MAX_REWRITES;
  assertPositiveInteger(maxIterations, "maxIterations");
  assertNonNegativeInteger(maxRewrites, "maxRewrites");

  const queryQueue = sortQueries(options.queries);
  const usedQueryKeys = new Set<string>();
  const seenEvidenceIds = new Set<string>();
  const seenEvidenceContents = new Set<string>();
  const evidence: E[] = [];
  const executedQueries: Q[] = [];
  const rewrittenQueries: Q[] = [];
  const grades: AgenticRagGrade[] = [];
  const trace: AgenticRagTraceItem[] = [
    createTraceItem({
      node: "plan",
      iteration: 0,
      evidenceCount: 0,
      detail: `已接收 ${queryQueue.length} 条规划查询`,
    }),
  ];

  let currentQuery = takeNextUnusedQuery(queryQueue, usedQueryKeys);
  if (!currentQuery) {
    trace.push(createTraceItem({
      node: "stop",
      iteration: 0,
      evidenceCount: 0,
      detail: "没有可执行的检索查询",
    }));
    return createResult({
      complete: false,
      stopReason: "no_queries",
      evidence,
      executedQueries,
      rewrittenQueries,
      grades,
      trace,
    });
  }

  while (currentQuery) {
    const iteration = executedQueries.length + 1;
    const queryKey = normalizeAgenticRagQuery(currentQuery.query);
    usedQueryKeys.add(queryKey);
    executedQueries.push(currentQuery);

    trace.push(createTraceItem({
      node: "retrieve",
      iteration,
      query: currentQuery.query,
      evidenceCount: evidence.length,
      detail: `执行查询：${currentQuery.query}`,
    }));

    const latestEvidence = appendUniqueEvidence({
      target: evidence,
      incoming: await options.retrieve(currentQuery, {
        question: options.question,
        currentQuery,
        evidence: [...evidence],
        executedQueries: [...executedQueries],
        iteration,
      }),
      seenIds: seenEvidenceIds,
      seenContents: seenEvidenceContents,
    });

    trace.push(createTraceItem({
      node: "grade",
      iteration,
      query: currentQuery.query,
      evidenceCount: evidence.length,
      detail: `本轮新增 ${latestEvidence.length} 条去重证据，开始判断相关性与充分性`,
    }));

    const grade = await options.grade({
      question: options.question,
      currentQuery,
      evidence: [...evidence],
      latestEvidence: [...latestEvidence],
      executedQueries: [...executedQueries],
      iteration,
    });
    grades.push({
      ...grade,
      missingInfo: Array.isArray(grade.missingInfo) ? grade.missingInfo.filter(Boolean) : [],
    });

    if (grade.sufficient) {
      trace.push(createTraceItem({
        node: "complete",
        iteration,
        query: currentQuery.query,
        evidenceCount: evidence.length,
        detail: grade.reason || "证据已充分",
      }));
      return createResult({
        complete: true,
        stopReason: "evidence_sufficient",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    if (iteration >= maxIterations) {
      trace.push(createTraceItem({
        node: "stop",
        iteration,
        query: currentQuery.query,
        evidenceCount: evidence.length,
        detail: `达到最大检索轮次 ${maxIterations}`,
      }));
      return createResult({
        complete: false,
        stopReason: "max_iterations",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    const plannedQuery = takeNextUnusedQuery(queryQueue, usedQueryKeys);
    if (plannedQuery) {
      currentQuery = plannedQuery;
      continue;
    }

    if (!options.rewrite) {
      trace.push(createTraceItem({
        node: "stop",
        iteration,
        query: currentQuery.query,
        evidenceCount: evidence.length,
        detail: "规划查询已耗尽且未配置查询改写器",
      }));
      return createResult({
        complete: false,
        stopReason: "no_queries",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    if (rewrittenQueries.length >= maxRewrites) {
      trace.push(createTraceItem({
        node: "stop",
        iteration,
        query: currentQuery.query,
        evidenceCount: evidence.length,
        detail: `达到最大查询改写次数 ${maxRewrites}`,
      }));
      return createResult({
        complete: false,
        stopReason: "max_rewrites",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    trace.push(createTraceItem({
      node: "rewrite",
      iteration,
      query: currentQuery.query,
      evidenceCount: evidence.length,
      detail: `根据证据缺口改写查询：${grade.missingInfo.join("；") || grade.reason || "证据不足"}`,
    }));

    const rewrittenQuery = await options.rewrite({
      question: options.question,
      grade,
      evidence: [...evidence],
      executedQueries: [...executedQueries],
      rewriteCount: rewrittenQueries.length + 1,
    });
    const rewrittenQueryKey = normalizeAgenticRagQuery(rewrittenQuery?.query || "");

    if (!rewrittenQuery || !rewrittenQueryKey) {
      trace.push(createTraceItem({
        node: "stop",
        iteration,
        evidenceCount: evidence.length,
        detail: "查询改写器未返回有效查询",
      }));
      return createResult({
        complete: false,
        stopReason: "empty_rewrite",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    if (usedQueryKeys.has(rewrittenQueryKey) || queryQueue.some(item => normalizeAgenticRagQuery(item.query) === rewrittenQueryKey)) {
      trace.push(createTraceItem({
        node: "stop",
        iteration,
        query: rewrittenQuery.query,
        evidenceCount: evidence.length,
        detail: "查询改写结果与已执行或待执行查询重复",
      }));
      return createResult({
        complete: false,
        stopReason: "duplicate_query",
        evidence,
        executedQueries,
        rewrittenQueries,
        grades,
        trace,
      });
    }

    rewrittenQueries.push(rewrittenQuery);
    currentQuery = rewrittenQuery;
  }

  trace.push(createTraceItem({
    node: "stop",
    iteration: executedQueries.length,
    evidenceCount: evidence.length,
    detail: "检索循环没有可继续执行的查询",
  }));
  return createResult({
    complete: false,
    stopReason: "no_queries",
    evidence,
    executedQueries,
    rewrittenQueries,
    grades,
    trace,
  });
}
