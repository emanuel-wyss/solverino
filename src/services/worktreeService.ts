import * as path from "path";
import { run, runOk, Logger, PromiseQueue } from "../util";
import { ItemKind, worktreeFolderName, branchName } from "../types";

export interface WorktreeInfo {
  branch: string;
  path: string;
  created: boolean;
  branchCreated: boolean;
}

export interface WorktreeEntry {
  branch: string;
  path: string;
}

export class WorktreeService {
  private readonly queue = new PromiseQueue();

  constructor(
    private readonly repoPath: string,
    private readonly parentFolder: string,
    private readonly logger: Logger
  ) {}

  static defaultParentFolder(repoPath: string): string {
    return path.dirname(path.resolve(repoPath));
  }

  static worktreePath(
    repoPath: string,
    parentFolder: string,
    kind: ItemKind,
    number: number
  ): string {
    const repoName = path.basename(path.resolve(repoPath)).replace(/\.git$/, "");
    const parent = parentFolder
      ? path.resolve(repoPath, parentFolder)
      : WorktreeService.defaultParentFolder(repoPath);
    return path.join(parent, worktreeFolderName(repoName, kind, number));
  }

  expectedPath(kind: ItemKind, number: number): string {
    return WorktreeService.worktreePath(
      this.repoPath,
      this.parentFolder,
      kind,
      number
    );
  }

  async ensure(
    kind: ItemKind,
    number: number,
    prHeadBranch?: string
  ): Promise<WorktreeInfo> {
    return this.queue.serialize(async () => {
      const branch =
        kind === "pr" && prHeadBranch
          ? prHeadBranch
          : branchName(kind, number);
      const wtPath = this.expectedPath(kind, number);
      const existing = await this.listStrict();
      const match = existing.find((w) => w.path === wtPath);
      if (match) {
        if (match.branch !== branch) {
          throw new Error(
            `Worktree path ${wtPath} is registered on branch "${match.branch}", but this item requires "${branch}". Move or remove the conflicting worktree first.`
          );
        }
        return {
          branch: match.branch,
          path: match.path,
          created: false,
          branchCreated: false,
        };
      }
      const startPoint = await this.resolveStartPoint(kind, number);
      const branchExists = await this.branchExists(branch);
      if (!branchExists) {
        await runOk(
          "git",
          ["worktree", "add", "-b", branch, wtPath, startPoint],
          {
            cwd: this.repoPath,
            logger: this.logger,
          }
        );
      } else {
        await runOk("git", ["worktree", "add", wtPath, branch], {
          cwd: this.repoPath,
          logger: this.logger,
        });
        if (kind === "pr") {
          await runOk("git", ["reset", "--hard", startPoint], {
            cwd: wtPath,
            logger: this.logger,
          }).catch(() => {});
        }
      }
      return {
        branch,
        path: wtPath,
        created: true,
        branchCreated: !branchExists,
      };
    });
  }

  async currentBranch(cwd: string): Promise<string | undefined> {
    try {
      const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        logger: this.logger,
      });
      const branch = result.stdout.trim();
      return result.code === 0 && branch && branch !== "HEAD"
        ? branch
        : undefined;
    } catch {
      return undefined;
    }
  }

  async hasRemoteBranch(branch: string): Promise<boolean> {
    try {
      const result = await run(
        "git",
        ["ls-remote", "--exit-code", "--heads", "origin", branch],
        { cwd: this.repoPath, logger: this.logger }
      );
      return result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async pushBranch(branch: string): Promise<void> {
    await runOk("git", ["push", "-u", "origin", branch], {
      cwd: this.repoPath,
      logger: this.logger,
    });
  }

  async remove(kind: ItemKind, number: number): Promise<void> {
    await this.queue.serialize(async () => {
      const wtPath = this.expectedPath(kind, number);
      const existing = await this.list();
      const match = existing.find((w) => w.path === wtPath);
      if (!match) {
        return;
      }
      await runOk("git", ["worktree", "remove", "--force", wtPath], {
        cwd: this.repoPath,
        logger: this.logger,
      });
      await runOk("git", ["branch", "-D", match.branch], {
        cwd: this.repoPath,
        logger: this.logger,
      }).catch(() => {});
      await runOk("git", ["worktree", "prune"], {
        cwd: this.repoPath,
        logger: this.logger,
      }).catch(() => {});
    });
  }

  async listStrict(): Promise<WorktreeEntry[]> {
    const result = await runOk(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: this.repoPath, logger: this.logger }
    );
    return WorktreeService.parseWorktreeList(result.stdout);
  }

  private static parseWorktreeList(
    porcelain: string
  ): WorktreeEntry[] {
    const worktrees: WorktreeEntry[] = [];
    let currentPath: string | undefined;
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ") && currentPath) {
        worktrees.push({
          branch: line.slice("branch refs/heads/".length),
          path: currentPath,
        });
        currentPath = undefined;
      }
    }
    return worktrees;
  }

  async list(): Promise<WorktreeEntry[]> {
    try {
      return await this.listStrict();
    } catch {
      return [];
    }
  }

  async dirtyFileCount(wtPath: string): Promise<number> {
    const result = await run("git", ["status", "--porcelain"], {
      cwd: wtPath,
      logger: this.logger,
    });
    if (result.code !== 0) {
      return 0;
    }
    return result.stdout.split("\n").filter((l) => l.trim().length > 0)
      .length;
  }

  async statusFiles(
    wtPath: string
  ): Promise<{ files: string[] }> {
    const result = await runOk("git", ["status", "--porcelain"], {
      cwd: wtPath,
      logger: this.logger,
    });
    const files = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\S+\s+/, ""))
      .map((f) => f.replace(/^"|"$/g, ""));
    return { files };
  }

  async unpushedCommitCount(
    wtPath: string,
    branch: string
  ): Promise<number> {
    const result = await runOk(
      "git",
      ["rev-list", "--count", branch, "--not", "--remotes"],
      { cwd: wtPath, logger: this.logger }
    ).catch(() => undefined);
    if (!result) {
      return 0;
    }
    const count = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  private async resolveStartPoint(
    kind: ItemKind,
    number: number
  ): Promise<string> {
    if (kind === "pr") {
      try {
        await runOk("git", ["fetch", "origin", `pull/${number}/head`], {
          cwd: this.repoPath,
          logger: this.logger,
        });
        return "FETCH_HEAD";
      } catch (e) {
        throw new Error(
          `Could not fetch the head of PR #${number}; refusing to build the worktree from unrelated code. (${
            e instanceof Error ? e.message : e
          })`
        );
      }
    }
    return "HEAD";
  }

  private async branchExists(branch: string): Promise<boolean> {
    const result = await runOk(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.repoPath, logger: this.logger }
    ).catch(() => undefined);
    return result !== undefined;
  }
}
