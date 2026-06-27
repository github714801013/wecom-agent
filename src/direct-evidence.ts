const DIRECT_EVIDENCE_SECTION_PATTERN = /原因分析\/调用链\/代码位置[:：]/u;
const DIRECT_EVIDENCE_CODE_ANCHOR_PATTERN = /(?:[A-Za-z0-9_-]+\.(?:cs|java|ts|js|py)|[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*->|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|:[0-9]{2,6})/u;
const DIRECT_EVIDENCE_ROOT_CAUSE_PATTERN = /根本原因\/排查方向[:：]|错误码\/状态码含义[:：]/u;

export function hasDirectEvidenceAnchors(question: string) {
  return DIRECT_EVIDENCE_SECTION_PATTERN.test(question) && DIRECT_EVIDENCE_CODE_ANCHOR_PATTERN.test(question);
}

export function shouldUseDirectEvidenceFastPath(question: string) {
  return hasDirectEvidenceAnchors(question) && DIRECT_EVIDENCE_ROOT_CAUSE_PATTERN.test(question);
}

export function buildDirectEvidenceRuntimeInstruction() {
  return `系统提示：【直接证据优先】
当前问题里已经包含截图或历史上下文给出的候选调用链、代码位置、方法名、文件路径、行号或错误码含义。
1. 优先核实这些精确锚点，不要重新发散到宽泛业务词。
2. 不要反问请求参数是否应该有值、是否等于其他字段、是否先经过上一步；这些应通过代码入口、参数映射、调用链和测试/dev 数据继续确认。
3. 一旦命中候选文件、方法或错误拼接逻辑，直接解释拦截点、外部返回含义和业务根因。
4. 在已给锚点足够时，跳过额外预检索，避免重复 query 循环。`;
}

export function buildDirectEvidenceFastPathInstruction() {
  return `系统提示：【直接证据快速收敛】
当前问题已经提供了结构化直接证据，包括候选调用链、代码位置、错误码含义和根本原因。
1. 优先基于这些直接证据组织最终回答，不要继续展开宽泛检索。
2. 如果直接证据已经足以回答“是什么原因”，直接解释接口入口、拦截点、第三方返回含义和业务根因。
3. 不要再反问空参数是否应有值、是否先经过上一阶段校验；这些属于可进一步核实项，不应覆盖当前主因。
4. 如需保留边界说明，只能说明“根据已提供的调用链/代码位置/错误码证据”，不要把回答退化成继续核实中。`;
}
