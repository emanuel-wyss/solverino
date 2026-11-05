export type ItemKind = "issue" | "pr";

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
