import { WSClient, MessageType } from "@wecom/aibot-node-sdk";
import { initializeAgent, runPlanner, getModelContextWindow, getBaseModel, getBusinessPrompt } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";

/**
 * 格式化工具调用显示，提取关键参数以提升用户体验
 */
function getToolDisplay(name: string, args: any): string {
  if (!args || args === '{}' || args === '') return name;
  
  let argsObj: any;
  try {
    if (typeof args === 'string') {
      argsObj = JSON.parse(args);
    } else {
      argsObj = args;
    }

    // 提取最能代表查询意图的参数
    const keyParams = ['query', 'searchText', 'pattern', 'target', 'symbol', 'path', 'table_name', 'sql'];
    for (const key of keyParams) {
      if (argsObj[key]) {
        const val = String(argsObj[key]);
        const truncated = val.length > 30 ? val.substring(0, 30) + "..." : val;
        return `${name}("${truncated}")`;
      }
    }
    // 如果没有匹配到常用参数，则显示简短的 JSON 片段
    const briefArgs = JSON.stringify(argsObj);
    return briefArgs.length > 40 ? `${name}(${briefArgs.substring(0, 40)}...)` : `${name}(${briefArgs})`;
  } catch {
    // 尝试正则匹配还没写完的 JSON 片段（流式过程中常见）
    if (typeof args === 'string') {
      const match = args.match(/"(query|searchText|pattern|target|symbol|path|table_name|sql)"\s*:\s*"([^"]*)"/);
      if (match && match[2]) {
        const val = match[2];
        const truncated = val.length > 30 ? val.substring(0, 30) + "..." : val;
        return `${name}("${truncated}...")`;
      }
    }
  }
  return name;
}

export function extractTextContent(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(item => item.type === "text" && item.text)
    .map(item => item.text)
    .join("\n");
}

export function isClearSessionCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?.]/g, "")
    .replace(/的/g, "");

  if (!normalized) return false;

  if (/^(怎么|如何|为什么|为何|查询|排查|分析|说明|解释)/.test(normalized)) {
    return false;
  }

  if (/(不生效|没生效|无效|失败|问题|原因)/.test(normalized)) {
    return false;
  }

  const exactCommands = new Set([
    "/new",
    "reset",
    "清理当前会话",
    "清理会话",
    "清空当前会话",
    "清空会话",
    "重置当前会话",
    "重置会话",
    "清理当前对话",
    "清理对话",
    "清空对话",
    "重置对话",
    "清理上下文",
    "清空上下文",
    "重置上下文",
    "清理记忆",
    "清空记忆",
    "忘记之前对话",
    "忘记历史对话"
  ]);

  if (exactCommands.has(normalized)) return true;

  const politePrefix = "(请|麻烦|麻烦你|帮我|帮忙|给我|帮我把|把)?";
  const scope = "(当前|本次|这次|这个|刚才|之前|历史|上面|前面|所有|全部)?";
  const filler = "(一下|下)?";
  const target = "(会话|对话|聊天记录|上下文|记忆|历史|内容|消息|记录)";

  const semanticPatterns = [
    new RegExp(`^${politePrefix}${scope}?(清理|清空|清除|删除|重置|刷新|抹掉|擦掉|删掉|清掉|清一下|清一清)${filler}${scope}?${target}(吧|一下|下)?$`),
    new RegExp(`^${politePrefix}${scope}?${target}(清理|清空|清除|删除|重置|刷新|抹掉|擦掉|删掉|清掉)${filler}(吧|一下|下)?$`),
    new RegExp(`^${politePrefix}(忘记|忘掉|不要记|别记|删除|清掉)${scope}?${target}(吧|一下|下)?$`),
    /^(重新开始|从头开始|新开会话|开启新会话|开始新会话|开始新的会话|开个新会话|另起会话|另起一个会话)$/,
    /^(不带上下文|不要上下文|不要带历史|不参考历史|不看历史|不看上文|忽略上文|忽略前文|忽略之前内容)$/
  ];

  return semanticPatterns.some(pattern => pattern.test(normalized));
}

/**
 * 将企业微信消息解析为智能体可理解的文本描述或多模态内容
 */
export async function parseWeComMessage(body: any, bot: WSClient): Promise<string | { type: string; text?: string; image_url?: { url: string } | string }[]> {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  
  // 1. 解析主消息内容
  let mainItems: any[] = [];
  switch (msgType) {
    case MessageType.Text:
      mainItems.push({ type: "text", text: body.text.content });
      break;

    case MessageType.Image:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一张图片]` });
      const b64Image = await fetchImageAsBase64(bot, body.image?.url, body.image?.aeskey);
      mainItems.push({ type: "image_url", image_url: { url: b64Image } });
      break;

    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}` });
      break;

    case MessageType.Video:
      const videoPath = await downloadMediaFile(bot, body.video?.url, body.video?.aeskey, '.mp4');
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})，已下载至本地临时路径: ${videoPath}` });
      break;

    case MessageType.File:
      const fileExt = body.file?.fileext ? `.${body.file.fileext}` : '.bin';
      const filePath = await downloadMediaFile(bot, body.file?.url, body.file?.aeskey, fileExt);
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}，已下载至本地临时路径: ${filePath}` });
      break;

    case "location":
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}` });
      break;

    case "mixed":
      // 图文混排
      const items = body.mixed?.msg_item || [];
      for (const item of items) {
        if (item.msgtype === "text") {
          mainItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          const b64 = await fetchImageAsBase64(bot, item.image?.url, item.image?.aeskey);
          mainItems.push({ type: "image_url", image_url: { url: b64 } });
        }
      }
      break;

    default:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]` });
      break;
  }

  // 2. 解析引用内容 (Quote)
  let quoteItems: any[] = [];
  if (body.quote) {
    const qType = body.quote.msgtype;
    if (qType === "text") {
      quoteItems.push({ type: "text", text: body.quote.text?.content });
    } else if (qType === "image") {
      const b64QuoteImg = await fetchImageAsBase64(bot, body.quote.image?.url, body.quote.image?.aeskey);
      quoteItems.push({ type: "image_url", image_url: { url: b64QuoteImg } });
    } else if (qType === "mixed") {
      const qMixedItems = body.quote.mixed?.msg_item || [];
      for (const item of qMixedItems) {
        if (item.msgtype === "text") {
          quoteItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          const b64QuoteMixedImg = await fetchImageAsBase64(bot, item.image?.url, item.image?.aeskey);
          quoteItems.push({ type: "image_url", image_url: { url: b64QuoteMixedImg } });
        }
      }
    } else {
      quoteItems.push({ type: "text", text: `[${qType} 消息]` });
    }
  }

  // 3. 组合与合并
  const hasImage = mainItems.some(i => i.type === "image_url") || quoteItems.some(i => i.type === "image_url");

  if (!hasImage) {
    // 纯文本模式：返回字符串
    const mainText = mainItems.map(i => i.text).filter(Boolean).join("\n");
    if (quoteItems.length > 0) {
      const quoteText = quoteItems.map(i => i.text).filter(Boolean).join(" ");
      return `[引用内容: ${quoteText}]\n\n${mainText}`;
    }
    return mainText;
  } else {
    // 多模态模式：返回数组
    const result: any[] = [];
    if (quoteItems.length > 0) {
      result.push({ type: "text", text: "[引用内容]:" });
      quoteItems.forEach(item => {
        if (item.type === "text") result.push({ type: "text", text: `> ${item.text}` });
        else result.push(item);
      });
      result.push({ type: "text", text: "\n" });
    }
    result.push(...mainItems);
    return result;
  }
}

export async function startBot() {
  const bot = new WSClient({
    botId: config.WECOM_BOT_ID,
    secret: config.WECOM_BOT_SECRET,
    wsUrl: config.WECOM_WS_URL, 
  });

  // 用于消息去重的简单缓存（在多实例部署时建议改用 Redis）
  const processedMsgs = new Set<string>();
  const MAX_CACHE_SIZE = 1000;

  // 监听所有消息类型
  bot.on("message", async (frame) => {
    const { body } = frame;
    if (!body || !body.msgid) return;
    
    // 1. 消息去重，防止企业微信重试导致重复处理
    if (processedMsgs.has(body.msgid)) {
      console.log(`[Deduplication] Message ${body.msgid} already processed, skipping.`);
      return;
    }
    processedMsgs.add(body.msgid);
    
    // 维持缓存大小
    if (processedMsgs.size > MAX_CACHE_SIZE) {
      const first = processedMsgs.values().next().value;
      if (first) processedMsgs.delete(first);
    }

    const parsedContent = await parseWeComMessage(body, bot);
    const chatType = body.chattype; // 'single' 或 'group'
    const fromUser = body.from?.userid;
    const chatId = body.chatid;

    // 生成唯一的会话 Key
    let sessionKey = "";
    if (chatType === "group" && chatId && fromUser) {
      sessionKey = `group:${chatId}:${fromUser}`;
    } else if (fromUser) {
      sessionKey = `single:${fromUser}`;
    } else {
      sessionKey = chatId || fromUser || "unknown";
    }

    // --- Session Handling Start ---
    const session = sessionManager.getOrCreateSession(sessionKey);

    // Handle high-priority system commands (Exact match only)
    const commandText = body.msgtype === MessageType.Text
      ? body.text?.content || ""
      : extractTextContent(parsedContent as any);
    const isHardcodedNew = isClearSessionCommand(commandText);

    if (isHardcodedNew) {
      sessionManager.clearSession(sessionKey);
      processedMsgs.add(body.msgid);
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        "已为您清理所有会话记录，我们可以开始新的对话了。",
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "会话已重置", desc: "历史记录已清理" },
            task_id: `task_${body.msgid}`,
          },
        }
      );
      return;
    }
    // --- Session Handling End ---

    try {
      const streamId = body.msgid;

      // 发送初始进度卡片
      await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
          task_id: `task_${body.msgid}`,
        }
      });

      let fullContent = "";
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 2000;

      // --- Planner Logic Start ---
      let finalContentForPrompt: any = parsedContent;
      let plannerResult = null;

      // 提取文本内容进行 Planner 分析
      let textToPlan = "";
      if (typeof parsedContent === 'string') {
        textToPlan = parsedContent;
      } else if (Array.isArray(parsedContent)) {
        const textItem = parsedContent.find(i => i.type === 'text');
        if (textItem) textToPlan = textItem.text || "";
      }

      if (textToPlan.trim().length > 0) {
        try {
          plannerResult = await runPlanner(textToPlan);
          if (plannerResult) {
            const queries = plannerResult.queries?.map(q => `- ${q.query} (${q.type}, 优先级: ${q.priority})`).join('\n') || '';
            const hypotheses = plannerResult.hypotheses?.map(h => `- ${h.title} (推荐查询: ${h.queries?.join(', ') || ''})`).join('\n') || '';
            
            // 优先使用去实例化检索词，避免品牌/租户/完整文案干扰代码搜索。
            const rawCodeTerms = plannerResult.code_terms?.combined || "";
            let cleanCodeTerms = plannerResult.code_terms?.stripped_combined || "";
            if (!cleanCodeTerms) {
              const allTerms = [
                ...(plannerResult.code_terms?.english || []),
                ...(plannerResult.code_terms?.chinese || []),
                ...(plannerResult.code_terms?.mixed || [])
              ].filter(t => t && t.length > 0);
              cleanCodeTerms = Array.from(new Set(allTerms)).join(' ');
            }
            
            const intents = [plannerResult.intent, ...(plannerResult.secondary_intents || [])].filter(Boolean).join(', ');
            const smsTemplateEvidenceHint = /短信|模板|文案|推送|发送|通知/.test(textToPlan)
              ? `

【短信/模板/推送来源通用证据规则】
当前问题涉及短信、模板、文案、推送、发送或通知来源。必须按证据优先排查：
1. 先从用户问题中提取“消息正文/模板正文”的稳定片段，剔除品牌、租户、人名、手机号、订单号、验证码、时间等实例值。
2. 使用 \`query\` 做业务流程召回后，必须用 \`zoekt_search\` 对稳定片段 + 发送动作词做精确验证；动作词优先包含 sms、message、template、push、send、notify、sendMessage。
3. 一旦命中代码文件，必须继续用 \`context\` 或 \`code_snippet\` 读取触发方法和发送调用附近代码。
4. 最终回答必须引用已命中的仓库、文件、方法和发送调用；没有直接代码/配置证据时，只能说明“未核实到直接来源”，禁止按业务经验猜测具体系统或流程。`
              : "";

            // 提供结构化的搜索建议，引导大模型按 MCP 要求进行高效率查询
            const searchPlanHint = `系统提示：【检索与分析规划建议】
意图识别: ${intents} (置信度: ${plannerResult.confidence})
标准问题: ${plannerResult.normalized_question}

【纯净逻辑检索词 (stripped_combined，优先用于 Zoekt/GitNexus 代码检索)】
${cleanCodeTerms}

【原始业务词 (combined，仅用于理解上下文，禁止直接作为代码检索词)】
${rawCodeTerms}

【推荐查询 (Queries)】
${queries}

【问题假设与排查方向】
${hypotheses}

【核心红线】
* **必须**首选调用 GitNexus 的 \`query\` 工具（多路召回语义搜索），使用“标准问题”配合核心业务词进行初步探测，以获取相关的“执行流 (Process)”。
* 只有当 \`query\` 工具未能精准锁定目标，或需要查找特定文本（如配置、日志、正则）时，才使用“纯净逻辑检索词”调用 \`zoekt_search\` 进行一站式检索。
* 严禁在代码检索中包含人名、商品名、租户名、订单号等实例数据。
* 如果意图模糊，参考问题假设进行进一步排查。
* 严禁拆分关键词进行多次循环搜索。${smsTemplateEvidenceHint}`;
            
            if (typeof parsedContent === 'string') {
              finalContentForPrompt = `${searchPlanHint}\n\n${parsedContent}`;
            } else if (Array.isArray(parsedContent)) {
              finalContentForPrompt = [
                { type: 'text', text: `${searchPlanHint}\n\n` },
                ...parsedContent
              ];
            }
          }
        } catch (err) {
          console.error("Planner execution failed:", err);
        }
      }
      // --- Planner Logic End ---

      // 记录流式过程中的所有消息，用于容错恢复
      let intermediateMessages: BaseMessage[] = [];

      try {
        const agent = await initializeAgent();
        const stream = await agent.stream({
          messages: [...session.messages, new HumanMessage({ content: finalContentForPrompt as any })],
        }, {
          recursionLimit: config.LLM_RECURSION_LIMIT,
          streamMode: "messages",
        });

        // 工具调用累加器：用于聚合流式的 tool_call_chunks
        const toolCallMap = new Map<string, { name: string; args: string; notified: boolean; completed: boolean }>();

        for await (const [message, metadata] of stream) {
          const msg = message as BaseMessage;
          intermediateMessages.push(msg); // 记录中间过程
          
          const type = (msg as any)._getType?.() || msg.constructor.name;
          
          // 处理工具执行结果：记录完整调用日志
          if (type === "tool" || type === "ToolMessage") {
            const toolMsg = msg as any;
            const id = toolMsg.tool_call_id;
            const entry = toolCallMap.get(id);
            if (entry) {
              entry.completed = true;
              console.log(`[Tool Call Success] Name: ${entry.name}, Args: ${entry.args}, Result Size: ${String(toolMsg.content).length}`);
            }
            continue;
          }

          if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
            const aiMsg = msg as any; // Cast to any to handle both AIMessage and AIMessageChunk
            
            // 处理工具调用：记录日志并发送状态反馈给企微
            if (aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) {
              for (const chunk of aiMsg.tool_call_chunks) {
                const id = chunk.id;
                if (!id) continue;
                if (!toolCallMap.has(id)) {
                  toolCallMap.set(id, { name: "", args: "", notified: false, completed: false });
                }
                const entry = toolCallMap.get(id)!;
                if (chunk.name) entry.name = chunk.name;
                if (chunk.args) entry.args += chunk.args;

                // 聚合当前所有正在活跃的调用（名字已知且未完成）
                const activeCalls = Array.from(toolCallMap.values())
                  .filter(c => c.name && !c.completed)
                  .map(c => `> 🔍 正在调用: ${getToolDisplay(c.name, c.args)}...`);
                
                if (activeCalls.length > 0) {
                  const statusMsg = fullContent 
                    ? `${fullContent}\n\n${activeCalls.join("\n")}` 
                    : activeCalls.join("\n");
                  
                  // 节流推送：避免高频更新导致前端闪烁
                  if (Date.now() - lastUpdateTime > 1000) { 
                    await bot.replyStream(frame, streamId, statusMsg, false);
                    lastUpdateTime = Date.now();
                  }
                }
              }
              continue;
            } else if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
                // 回退逻辑：如果模型非流式返回，直接使用 tool_calls
                for (const tool of aiMsg.tool_calls) {
                  if (!tool.name) continue;
                  console.log(`[Tool Call] Name: ${tool.name}, Args: ${JSON.stringify(tool.args)}`);
                  const statusMsg = fullContent 
                    ? `${fullContent}\n\n> 🔍 正在调用: ${getToolDisplay(tool.name, tool.args)}...` 
                    : `> 🔍 正在调用: ${getToolDisplay(tool.name, tool.args)}...`;
                  await bot.replyStream(frame, streamId, statusMsg, false);
                }
                continue;
            }

            if (aiMsg.content) {
              const delta = aiMsg.content.toString();
              if (delta.length > 0) {
                if (fullContent && delta.startsWith(fullContent)) {
                    fullContent = delta;
                } else {
                    fullContent += delta;
                }

                if (fullContent && Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                  await bot.replyStream(frame, streamId, fullContent, false);
                  lastUpdateTime = Date.now();
                }
              }
            }
          }
        }

        // 最终检查：记录那些可能未返回 ToolMessage 的调用
        for (const [id, entry] of toolCallMap.entries()) {
          if (!entry.completed && entry.name) {
            console.log(`[Tool Call Pending/Final] Name: ${entry.name}, Args: ${entry.args}`);
          }
        }

      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        
        // 特别处理递归超限错误 (GRAPH_RECURSION_LIMIT)
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.message?.includes('Recursion limit')) {
          try {
            console.log(`[Recovery] Recursion limit reached for ${body.msgid}, attempting fallback synthesis...`);
            const baseModel = await getBaseModel();
            const businessPrompt = await getBusinessPrompt();

            // 构造恢复提示词：将已有的所有中间历史（包括工具调用和结果）发给不带 tools 的大模型进行总结
            const recoveryMessages = [
              new SystemMessage(`${businessPrompt}\n\n注意：当前任务由于逻辑过于复杂已达到执行上限。请根据下述已有的中间查询结果（包括已调用的工具返回），尽可能为用户提供一个阶段性的总结回答。如果关键信息不足，请明确告知已查到的部分，并指引用户如何提供更精确的信息以继续。`),
              ...session.messages,
              new HumanMessage({ content: finalContentForPrompt as any }),
              ...intermediateMessages
            ];

            const recoveryResponse = await baseModel.invoke(recoveryMessages);
            fullContent = recoveryResponse.content.toString();
          } catch (recoveryErr) {
            console.error(`Recovery synthesis failed for ${body.msgid}:`, recoveryErr);
            fullContent = fullContent || "抱歉，由于问题过于复杂且处理达到限制，我暂时无法给出完整回答。您可以尝试缩小查询范围。";
          }
        } else {
          fullContent = fullContent || "抱歉，处理您的请求时遇到了意外错误，请稍后重试。";
        }
      }

      // --- Update Session History ---
      if (fullContent) {
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: parsedContent as any }),
          ...intermediateMessages,
          new AIMessage(fullContent),
        ]);
      }

      // 发送最终结果
      await bot.replyStream(
        frame,
        streamId,
        fullContent || "未获取到有效回复",
        true
      );
    } catch (error) {
      console.error(`Outer error processing message ${body.msgid}:`, error);
    }
  });

  bot.on("connected", () => console.log("WeCom WebSocket connected."));
  bot.on("authenticated", () => console.log("WeCom Authentication successful."));
  bot.on("error", (err) => console.error("WeCom WebSocket error:", err));

  bot.connect();
  const contextWindow = getModelContextWindow();
  console.log(`WeCom Bot starting... Model: ${config.LLM_MODEL_NAME}, Recursion Limit: ${config.LLM_RECURSION_LIMIT}, Context Window: ${contextWindow} tokens`);
}
