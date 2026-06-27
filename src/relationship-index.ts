export interface RelationshipEdge {
  from: string;
  to: string;
  relation: string;
  evidence?: string;
}

export interface CompressionCallChainEdge {
  from: string;
  to: string;
  relation: string;
}

const MAX_NODE_LENGTH = 80;
const MAX_EVIDENCE_LENGTH = 120;
const RELATION_TEXT_PATTERN = /([/@A-Za-z_$\u4e00-\u9fa5][\w$./{}\-\u4e00-\u9fa5]{1,79})\s*(调用了?|->|→|进入|转到|路由到|触发|查询|发布|消费)\s*([/@A-Za-z_$\u4e00-\u9fa5][\w$./{}\-\u4e00-\u9fa5]{1,79})/gu;

function compactWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeNode(text: string) {
  return compactWhitespace(text)
    .replace(/^[，。！？!?,;；：:、"'`()[\]{}<>]+|[，。！？!?,;；：:、"'`()[\]{}<>]+$/gu, "")
    .slice(0, MAX_NODE_LENGTH);
}

function normalizeRelation(relation: string) {
  if (relation === "->" || relation === "→") return "calls";
  if (/调用/u.test(relation)) return "calls";
  if (/查询/u.test(relation)) return "queries";
  if (/发布/u.test(relation)) return "publishes";
  if (/消费/u.test(relation)) return "consumes";
  if (/触发/u.test(relation)) return "triggers";
  if (/进入|转到|路由到/u.test(relation)) return "routes_to";
  return relation || "relates_to";
}

function edgeKey(edge: RelationshipEdge) {
  return `${edge.from}\u0000${edge.relation}\u0000${edge.to}`;
}

function uniqueEdges(edges: RelationshipEdge[], maxEdges: number) {
  const seen = new Set<string>();
  const result: RelationshipEdge[] = [];
  for (const edge of edges) {
    if (!edge.from || !edge.to || edge.from === edge.to) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
    if (result.length >= maxEdges) break;
  }
  return result;
}

export function relationshipEdgesFromCallChain(callChain: CompressionCallChainEdge[] = []) {
  return callChain.map(edge => ({
    from: normalizeNode(edge.from),
    to: normalizeNode(edge.to),
    relation: normalizeRelation(edge.relation),
  })).filter(edge => edge.from && edge.to);
}

export function relationshipEdgesFromText(text: string, maxEdges = 12) {
  const edges: RelationshipEdge[] = [];
  for (const line of text.split(/\r?\n/gu)) {
    const compacted = compactWhitespace(line);
    if (!compacted) continue;
    for (const match of compacted.matchAll(RELATION_TEXT_PATTERN)) {
      const from = normalizeNode(match[1] || "");
      const relation = normalizeRelation(match[2] || "");
      const to = normalizeNode(match[3] || "");
      if (!from || !to || from === to) continue;
      edges.push({
        from,
        relation,
        to,
        evidence: compacted.slice(0, MAX_EVIDENCE_LENGTH),
      });
      if (edges.length >= maxEdges) return uniqueEdges(edges, maxEdges);
    }
  }
  return uniqueEdges(edges, maxEdges);
}

export function buildRelationshipIndex(input: {
  callChain?: CompressionCallChainEdge[];
  texts?: string[];
  maxEdges?: number;
}) {
  const maxEdges = input.maxEdges ?? 12;
  return uniqueEdges([
    ...relationshipEdgesFromCallChain(input.callChain || []),
    ...(input.texts || []).flatMap(text => relationshipEdgesFromText(text, maxEdges)),
  ], maxEdges);
}

export function formatRelationshipIndex(edges: RelationshipEdge[], emptyText = "- 暂无明确关系索引") {
  if (edges.length === 0) return emptyText;
  return edges.map(edge => {
    const evidence = edge.evidence ? `；依据：${edge.evidence}` : "";
    return `- ${edge.from} --${edge.relation}--> ${edge.to}${evidence}`;
  }).join("\n");
}
