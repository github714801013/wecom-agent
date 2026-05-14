import { BaseMessage } from "@langchain/core/messages";

export interface Session {
  messages: BaseMessage[];
  lastActivity: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly SESSION_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes
  private readonly MAX_MESSAGES_PER_SESSION = 20;

  getOrCreateSession(sessionKey: string): Session {
    const now = Date.now();
    let session = this.sessions.get(sessionKey);

    if (session) {
      // Expiration check
      if (now - session.lastActivity > this.SESSION_EXPIRATION_MS) {
        console.log(`[Session] Session for ${sessionKey} expired, clearing history.`);
        session.messages = [];
      }
      // Count check
      this.pruneSession(session);
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

  addMessages(sessionKey: string, newMessages: BaseMessage[]) {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = { messages: [], lastActivity: Date.now() };
      this.sessions.set(sessionKey, session);
    }
    session.messages.push(...newMessages);
    this.pruneSession(session);
    session.lastActivity = Date.now();
  }

  private pruneSession(session: Session) {
    if (session.messages.length > this.MAX_MESSAGES_PER_SESSION) {
      session.messages = session.messages.slice(-this.MAX_MESSAGES_PER_SESSION);
    }
  }
}

export const sessionManager = new SessionManager();
