export type SensitiveCredentialType =
  | "account_identifier"
  | "account_password"
  | "password"
  | "token"
  | "api_key"
  | "secret"
  | "cookie_session"
  | "private_key"
  | "credential";

export interface SensitiveRequestDecision {
  blocked: boolean;
  category: "credential_disclosure" | null;
  matchedCredentialTypes: SensitiveCredentialType[];
}

export interface SensitiveRequestAuditContext {
  botName: string;
  botId: string;
  msgId: string;
  sessionKey: string;
  userId?: string;
  chatId?: string;
  chatType?: string;
}

export interface SensitiveRequestAuditEvent {
  event: "sensitive_request_blocked";
  version: 1;
  occurredAt: string;
  severity: "warning";
  category: "credential_disclosure";
  matchedCredentialTypes: SensitiveCredentialType[];
  botName: string;
  botId: string;
  msgId: string;
  sessionKey: string;
  userId?: string;
  chatId?: string;
  chatType?: string;
}

const CREDENTIAL_PATTERNS: ReadonlyArray<{
  type: SensitiveCredentialType;
  pattern: RegExp;
}> = [
  {
    type: "account_password",
    pattern: /(?:账号|帐号|用户名|登录名|user(?:name)?|account)\s*(?:和|与|及|、|\/|&|\+)?\s*(?:密码|口令|pass(?:word)?|pwd)|(?:账号密码|帐号密码|用户名密码|登录账号密码)/iu,
  },
  {
    type: "account_identifier",
    pattern: /(?:账号|帐号|用户名|登录名|user(?:name)?|account)/iu,
  },
  {
    type: "password",
    pattern: /(?:密码|口令|passwd|password|pwd)/iu,
  },
  {
    type: "token",
    pattern: /(?:access[\s_-]*token|refresh[\s_-]*token|id[\s_-]*token|token|访问令牌|刷新令牌|令牌)/iu,
  },
  {
    type: "api_key",
    pattern: /(?:api[\s_-]*key|apikey|接口密钥)/iu,
  },
  {
    type: "secret",
    pattern: /(?:client[\s_-]*secret|app[\s_-]*secret|secret|密钥)/iu,
  },
  {
    type: "cookie_session",
    pattern: /(?:cookie|session(?:[\s_-]*(?:id|key|token))?|会话凭证|会话令牌)/iu,
  },
  {
    type: "private_key",
    pattern: /(?:私钥|private[\s_-]*key)/iu,
  },
  {
    type: "credential",
    pattern: /(?:credential|凭据|认证信息|登录信息)/iu,
  },
];

const SAFE_OPERATION_PATTERN = /(?:如何|怎么|怎样|应该|需要|能否|可以)?\s*(?:修改|重置|找回|更换|更新|轮换|吊销|撤销|申请|开通|保存|存储|保管|管理|保护|加密|脱敏|隐藏|校验|验证|锁定|解锁|排查|拦截|检测|防止|避免)|(?:过期|失效|规则|复杂度|策略|有效期|过期时间|最后修改时间|修改时间|权限申请|申请流程|使用规范|安全规范|安全配置|泄露风险|风险评估|登录失败|无法登录|不能登录|为空|null|缺失|不生效|是否正确|原因)/iu;
const SAFE_TECHNICAL_DEFINITION_PATTERN = /(?:字段|参数|变量|配置项|含义|作用|用途|格式|类型|命名|接口定义|代码定义|正则|脱敏规则|代码|源码|接口|逻辑|实现|调用链|鉴权|认证)/iu;
const SAFE_CONCEPT_PATTERN = /^(?:(?:请)?(?:解释|介绍)(?:一下)?|什么是)?\s*(?:token|api[\s_-]*key|cookie|session|secret|credential|凭据|访问令牌)\s*(?:是什么|有什么作用|的作用|怎么工作|如何工作)?\s*[？?]?$/iu;

const STRONG_DISCLOSURE_PATTERN = /(?:给我|发我|告诉我|提供给我|提供一下|返回给我|展示给我|显示给我|导出|读取|读出|列出|打印|复制|粘贴|找出|拿到|获取到|泄露|绕过|破解|show\s+me|give\s+me|send\s+me|tell\s+me|provide|reveal|print|copy|paste|export|dump|read|retrieve|fetch|list)/iu;
const GENERIC_LOOKUP_PATTERN = /(?:帮我)?(?:查一下|查询|查找|查看|获取|找一下|搜一下|搜索|定位)|哪里能看到|在哪(?:里|儿)?|what\s+is|what's|where\s+is|which|how\s+can\s+i\s+get/iu;
const VALUE_QUESTION_PATTERN = /(?:是什么|是多少|具体值|真实值|明文|原值|值为多少|哪一个|哪个值|what\s+is|what's)/iu;
const SOURCE_EXTRACTION_PATTERN = /(?:从|在).{0,24}(?:\.env|环境变量|配置文件|数据库|日志|代码|服务器|容器|k8s|docker|jenkins).{0,24}(?:读取|读出|查|找|获取|导出|拿|取)|(?:读取|读出|查|找|获取|导出).{0,24}(?:\.env|环境变量|配置文件|数据库|日志|代码|服务器|容器|k8s|docker|jenkins)/iu;
const SENSITIVE_VALUE_PATTERN = /(?:明文|真实值|原值|完整值|未脱敏|不要脱敏)/iu;
const SPECIFIC_CREDENTIAL_PATTERN = /(?:[\p{L}\p{N}_.-]{2,48}|生产(?:库|环境)|测试(?:库|环境)|开发(?:库|环境)|数据库|服务器|系统|平台|项目|应用|机器人)(?:的|\s)*(?:账号密码|账号.{0,4}密码|用户名.{0,4}密码|密码|口令|access[\s_-]*token|refresh[\s_-]*token|token|client[\s_-]*secret|app[\s_-]*secret|secret|api[\s_-]*key|cookie|session|私钥|凭据)/iu;

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function collectPayloadText(payload: unknown, output: string[], depth = 0): void {
  if (!payload || typeof payload !== "object" || depth > 3) return;

  const record = payload as Record<string, unknown>;
  const text = record.text;
  if (text && typeof text === "object") {
    const content = (text as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) output.push(content);
  }

  const voice = record.voice;
  if (voice && typeof voice === "object") {
    const recognition = (voice as Record<string, unknown>).recognition;
    if (typeof recognition === "string" && recognition.trim()) output.push(recognition);
  }

  const mixed = record.mixed;
  if (mixed && typeof mixed === "object") {
    const items = (mixed as Record<string, unknown>).msg_item;
    if (Array.isArray(items)) {
      for (const item of items) collectPayloadText(item, output, depth + 1);
    }
  }
}

export function extractSensitiveRequestPreflightText(body: unknown): string {
  const output: string[] = [];
  collectPayloadText(body, output);

  if (body && typeof body === "object") {
    collectPayloadText((body as Record<string, unknown>).quote, output);
  }

  return output.join("\n").trim();
}

export function detectSensitiveCredentialRequest(input: string): SensitiveRequestDecision {
  const text = normalizeText(input);
  if (!text) {
    return { blocked: false, category: null, matchedCredentialTypes: [] };
  }

  const matchedCredentialTypes = CREDENTIAL_PATTERNS
    .filter(item => item.pattern.test(text))
    .map(item => item.type);

  if (matchedCredentialTypes.length === 0 || SAFE_CONCEPT_PATTERN.test(text)) {
    return { blocked: false, category: null, matchedCredentialTypes };
  }

  const hasStrongDisclosureIntent = STRONG_DISCLOSURE_PATTERN.test(text);
  const hasSourceExtractionIntent = SOURCE_EXTRACTION_PATTERN.test(text);
  const hasSensitiveValueIntent = SENSITIVE_VALUE_PATTERN.test(text);
  const hasSafePurpose = SAFE_OPERATION_PATTERN.test(text) || SAFE_TECHNICAL_DEFINITION_PATTERN.test(text);

  if (hasSafePurpose && !hasStrongDisclosureIntent && !hasSourceExtractionIntent && !hasSensitiveValueIntent) {
    return { blocked: false, category: null, matchedCredentialTypes };
  }

  const hasDisclosureIntent = hasStrongDisclosureIntent
    || hasSourceExtractionIntent
    || hasSensitiveValueIntent
    || GENERIC_LOOKUP_PATTERN.test(text)
    || VALUE_QUESTION_PATTERN.test(text)
    || SPECIFIC_CREDENTIAL_PATTERN.test(text)
    || matchedCredentialTypes.includes("account_password");

  return hasDisclosureIntent
    ? { blocked: true, category: "credential_disclosure", matchedCredentialTypes }
    : { blocked: false, category: null, matchedCredentialTypes };
}

export function buildSensitiveRequestBlockedReply(): string {
  return "安全提醒：该请求涉及账号、密码或其他认证凭据，已被系统前置拦截。本次不会调用任何查询工具，也不会检索或返回相关敏感信息。该行为已被后台安全审计记录。";
}

export function buildSensitiveRequestAuditEvent(
  context: SensitiveRequestAuditContext,
  decision: SensitiveRequestDecision,
  occurredAt = new Date(),
): SensitiveRequestAuditEvent {
  if (!decision.blocked || decision.category !== "credential_disclosure") {
    throw new Error("Only blocked credential disclosure decisions can create a security audit event.");
  }

  const event: SensitiveRequestAuditEvent = {
    event: "sensitive_request_blocked",
    version: 1,
    occurredAt: occurredAt.toISOString(),
    severity: "warning",
    category: decision.category,
    matchedCredentialTypes: [...decision.matchedCredentialTypes],
    botName: context.botName,
    botId: context.botId,
    msgId: context.msgId,
    sessionKey: context.sessionKey,
  };

  if (context.userId) event.userId = context.userId;
  if (context.chatId) event.chatId = context.chatId;
  if (context.chatType) event.chatType = context.chatType;

  return event;
}
