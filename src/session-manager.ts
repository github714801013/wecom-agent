import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { runCompressor, getModelContextWindow } from "./graph.js";

export interface Session {
  messages: BaseMessage[];
  lastActivity: number;
  isCompressed?: boolean;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly SESSION_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes
  private readonly MAX_MESSAGES_PER_SESSION = 100; // Increased to allow more room for compression
  private readonly COMPRESSION_THRESHOLD_PERCENT = 0.6; // Trigger at 60% of context window

  getOrCreateSession(sessionKey: string): Session {
    const now = Date.now();
    let session = this.sessions.get(sessionKey);

    if (session) {
      // Expiration check
      if (now - session.lastActivity > this.SESSION_EXPIRATION_MS) {
        console.log(`[Session] Session for ${sessionKey} expired, clearing history.`);
        session.messages = [];
        session.isCompressed = false;
      }
    } else {
      session = { messages: [], lastActivity: now };
      this.sessions.set(sessionKey, session);
    }

    session.lastActivity = now;
    return session;
  }

  updateActivity(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  clearSession(sessionKey: string) {
    console.log(`[Session] Clearing session for ${sessionKey}`);
    this.sessions.delete(sessionKey);
  }

  async addMessages(sessionKey: string, newMessages: BaseMessage[]) {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = { messages: [], lastActivity: Date.now() };
      this.sessions.set(sessionKey, session);
    }
    session.messages.push(...newMessages);
    
    // Check for compression
    await this.checkAndCompress(sessionKey, session);
    
    this.pruneSession(session);
    session.lastActivity = Date.now();
  }

  private estimateTokens(messages: BaseMessage[]): number {
    // Rough estimation: 1 token ≈ 4 characters for English, 1 token ≈ 1-2 characters for Chinese
    // We'll use a conservative 1 token ≈ 3 characters average
    return messages.reduce((acc, msg) => acc + (msg.content.toString().length / 3), 0);
  }

  private async checkAndCompress(sessionKey: string, session: Session) {
    const contextWindow = getModelContextWindow();
    const currentTokens = this.estimateTokens(session.messages);

    if (currentTokens > contextWindow * this.COMPRESSION_THRESHOLD_PERCENT && session.messages.length > 5) {
      console.log(`[Session] Context size (${Math.round(currentTokens)} tokens) exceeds threshold. Triggering compression...`);
      
      try {
        // Prepare input for compressor
        // We treat historical AIMessages as "search results" if they contain code
        const searchResults = session.messages
          .filter(m => m instanceof AIMessage)
          .map((m, i) => ({
            id: `hist_${i}`,
            content: m.content.toString(),
            type: "historical_context"
          }));

        const lastHumanMsg = session.messages.reverse().find(m => m instanceof HumanMessage);
        const userQuestion = lastHumanMsg ? lastHumanMsg.content.toString() : "Summary of previous conversation";
        session.messages.reverse(); // Restore order

        const compressionResult = await runCompressor({
          user_question: userQuestion,
          search_results: searchResults,
          token_budget: {
            target: Math.floor(contextWindow * 0.2), // Aim for 20% of window
            max_per_section: 1000,
            mode: "balanced"
          }
        });

        if (compressionResult && compressionResult.status === 'ok') {
          // Replace history with a single compressed context message
          const summary = `【历史上下文自动压缩】
意图: ${compressionResult.intent}
关键证据:
${compressionResult.key_evidence.map(e => `- ${e}`).join('\n')}

压缩后的代码上下文:
${compressionResult.compressed_sections.map(s => `文件: ${s.file_path}\n内容: ${s.content}`).join('\n---\n')}

缺失信息: ${compressionResult.missing_info.join(', ')}`;

          session.messages = [
            new SystemMessage(`这是之前对话的压缩总结，请基于此继续回答：\n\n${summary}`),
            ...(lastHumanMsg ? [lastHumanMsg] : [])
          ];
          session.isCompressed = true;
          console.log(`[Session] Compression successful for ${sessionKey}`);
        }
      } catch (err) {
        console.error(`[Session] Compression failed for ${sessionKey}:`, err);
      }
    }
  }

  private pruneSession(session: Session) {
    if (session.messages.length > this.MAX_MESSAGES_PER_SESSION) {
      session.messages = session.messages.slice(-this.MAX_MESSAGES_PER_SESSION);
    }
  }
}

export const sessionManager = new SessionManager();
