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

export interface ParsedWorktreeName {
  repoName: string;
  kind: ItemKind;
  number: number;
}

export function parseWorktreeFolderName(
  folderName: string
): ParsedWorktreeName | undefined {
  const match = /^solverino-(.+)-(issue|pr)-(\d+)$/.exec(folderName);
  if (!match) {
    return undefined;
  }
  return {
    repoName: match[1],
    kind: match[2] as ItemKind,
    number: parseInt(match[3], 10),
  };
}
