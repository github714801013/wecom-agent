const DIRECT_EVIDENCE_SECTION_PATTERN = /原因分析\/调用链\/代码位置[:：]/u;
const DIRECT_EVIDENCE_CODE_ANCHOR_PATTERN = /(?:[A-Za-z0-9_-]+\.(?:cs|java|ts|js|py)|[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*->|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|:[0-9]{2,6})/u;
const DIRECT_EVIDENCE_ROOT_CAUSE_PATTERN = /根本原因\/排查方向[:：]|错误码\/状态码含义[:：]/u;
const DIRECT_EVIDENCE_LOOKUP_INTENT_PATTERN = /是什么|做什么用|作用是什么|哪里推送|哪里消费|谁推送|谁消费|哪里来的|到哪里去|谁写入|谁读取|谁调用|被谁调用|值从哪里来|显示条件是什么|干啥的|用途/u;

export function hasDirectEvidenceAnchors(question: string) {
  return DIRECT_EVIDENCE_SECTION_PATTERN.test(question) && DIRECT_EVIDENCE_CODE_ANCHOR_PATTERN.test(question);
}

export function shouldUseDirectEvidenceFastPath(question: string) {
  return hasDirectEvidenceAnchors(question)
    && DIRECT_EVIDENCE_ROOT_CAUSE_PATTERN.test(question)
    && !DIRECT_EVIDENCE_LOOKUP_INTENT_PATTERN.test(question);
}

export function shouldUseWeComDirectEvidenceFastPath(_question: string) {
  return false;
}

export function buildEntryAnchorGraphInstruction() {
  return `系统提示：【入口锚点优先】
当前问题明确给出了代码入口（接口路径、方法名或文件行号），或包含页面截图、提示文案、短信模板等精确可见信息。
1. 精确可见信息优先定位：截图中的文案、页面提示、短信模板正文、接口路径、方法名、文件行号等精确信息优先作为检索锚点，不要先用宽泛业务词发散搜索。
2. 先定位板块再精确查询：优先确定目标板块（模块/项目/服务/仓库），定位后再在板块内做精确查询；不要一开始就跨板块广撒网。
3. 精确找到入口：用检索工具的精确匹配能力（如 zoekt 精确词匹配）查询入口路径的最后一段、方法名或文案稳定片段，直接定位所在文件和函数。
4. 命中入口后拉取图信息：用上下文/影响分析类工具获取该入口的调用链、上下游调用方、被调用方与数据来源。
5. 根据图信息从代码整理答案：沿调用图定位相关实现（如 SQL 来源、处理逻辑、写入读取点、文案拼接与发送调用），基于代码证据组织最终回答；只引用图信息和代码中核实到的内容，不要凭业务经验推断。`;
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
