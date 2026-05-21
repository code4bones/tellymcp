import type { SessionContext } from "../../../entities/session/model/types";
import type { SessionStore } from "../../api/storage/contract";

type ProcessLocalSessionStoreInput = {
  initialSessions?: SessionContext[];
  onClearSession?: (sessionId: string) => Promise<void>;
};

export class ProcessLocalSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly onClearSession:
    | ((sessionId: string) => Promise<void>)
    | undefined;

  public constructor(input: ProcessLocalSessionStoreInput = {}) {
    this.onClearSession = input.onClearSession;
    for (const session of input.initialSessions ?? []) {
      this.sessions.set(session.sessionId, session);
    }
  }

  public async getSession(sessionId: string): Promise<SessionContext | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  public async listSessions(): Promise<SessionContext[]> {
    return Array.from(this.sessions.values()).sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  }

  public async setSession(session: SessionContext): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  public async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.onClearSession?.(sessionId);
  }
}
