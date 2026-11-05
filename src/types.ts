export type ItemKind = "issue" | "pr";

export type SessionStatus =
  | "idle"
  | "working"
  | "needsReview"
  | "prOpened"
  | "error";

export interface GitHubItem {
  kind: ItemKind;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string;
  updatedAt: string;
  assignees?: string[];
  reviewRequests?: string[];
}

export interface ChatMessage {
  role: "user" | "agent" | "system";
  text: string;
  timestamp: number;
  streaming?: boolean;
}

export interface ChatSession {
  id: string;
  kind: ItemKind;
  number: number;
  title: string;
  branch?: string;
  branchOwned?: boolean;
  worktreePath?: string;
  status: SessionStatus;
  history: ChatMessage[];
  prUrl?: string;
  errorMessage?: string;
}

export function sessionId(kind: ItemKind, number: number): string {
  return `${kind}-${number}`;
}

export function branchName(kind: ItemKind, number: number): string {
  return `${kind}-${number}`;
}

export function worktreeFolderName(
  repoName: string,
  kind: ItemKind,
  number: number
): string {
  return `solverino-${repoName}-${kind}-${number}`;
}
