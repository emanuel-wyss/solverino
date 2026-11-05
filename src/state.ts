import * as vscode from "vscode";
import { ChatSession, ChatMessage, GitHubItem, ItemKind, SessionStatus, sessionId } from "./types";

const STORAGE_KEY = "swarmforge.sessions";

interface PersistedSession {
  id: string;
  kind: ItemKind;
  number: number;
  title: string;
  branch?: string;
  worktreePath?: string;
  status: SessionStatus;
  history: ChatMessage[];
  prUrl?: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly context: vscode.ExtensionContext) {
    try {
      const raw = this.context.workspaceState.get<string>(STORAGE_KEY);
      if (raw) {
        for (const p of JSON.parse(raw) as PersistedSession[]) {
          if (p.status === "working") {
            p.status = "idle";
          }
          this.sessions.set(p.id, { ...p, history: p.history ?? [] });
        }
      }
    } catch {
      // corrupted storage: start fresh
    }
  }

  getOrCreate(item: GitHubItem): ChatSession {
    const id = sessionId(item.kind, item.number);
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        kind: item.kind,
        number: item.number,
        title: item.title,
        status: "idle",
        history: [],
      };
      this.sessions.set(id, session);
    } else {
      session.title = item.title;
    }
    return session;
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  all(): ChatSession[] {
    return [...this.sessions.values()];
  }

  update(id: string, patch: Partial<ChatSession>): ChatSession | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    Object.assign(session, patch);
    this.persist();
    return session;
  }

  appendMessage(id: string, message: ChatMessage): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.history.push(message);
    this.persist();
  }

  replaceLastAgentMessage(id: string, text: string, streaming: boolean): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    const last = session.history[session.history.length - 1];
    if (last && last.role === "agent" && last.streaming) {
      session.history[session.history.length - 1] = {
        ...last,
        text,
        streaming,
      };
    } else {
      session.history.push({
        role: "agent",
        text,
        timestamp: Date.now(),
        streaming,
      });
    }
    this.persist();
  }

  private persist(): void {
    const persisted: PersistedSession[] = this.all().map((s) => ({
      id: s.id,
      kind: s.kind,
      number: s.number,
      title: s.title,
      branch: s.branch,
      worktreePath: s.worktreePath,
      status: s.status,
      history: s.history,
      prUrl: s.prUrl,
    }));
    void this.context.workspaceState.update(
      STORAGE_KEY,
      JSON.stringify(persisted)
    );
  }
}
