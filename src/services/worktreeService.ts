import * as path from "path";
import { runOk, Logger, PromiseQueue } from "../util";
import { ItemKind, worktreeFolderName, branchName } from "../types";

export interface WorktreeInfo {
  branch: string;
  path: string;
  created: boolean;
  branchCreated: boolean;
}

export class WorktreeService {
  private readonly queue = new PromiseQueue();

  constructor(
    private readonly repoPath: string,
    private readonly parentFolder: string,
    private readonly envSetupCommand: string,
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

  async ensure(kind: ItemKind, number: number): Promise<WorktreeInfo> {
    return this.queue.serialize(async () => {
      const branch = branchName(kind, number);
      const wtPath = WorktreeService.worktreePath(
        this.repoPath,
        this.parentFolder,
        kind,
        number
      );
      const existing = await this.list();
      const match = existing.find((w) => w.path === wtPath);
      if (match) {
        return {
          branch: match.branch,
          path: match.path,
          created: false,
          branchCreated: false,
        };
      }
      const branchExists = await this.branchExists(branch);
      if (!branchExists) {
        const startPoint = await this.resolveStartPoint(kind, number);
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
      }
      await this.runEnvSetup(wtPath);
      return {
        branch,
        path: wtPath,
        created: true,
        branchCreated: !branchExists,
      };
    });
  }

  async remove(
    kind: ItemKind,
    number: number,
    deleteBranch = true
  ): Promise<void> {
    await this.queue.serialize(async () => {
      const wtPath = WorktreeService.worktreePath(
        this.repoPath,
        this.parentFolder,
        kind,
        number
      );
      const existing = await this.list();
      if (!existing.some((w) => w.path === wtPath)) {
        return;
      }
      await runOk("git", ["worktree", "remove", "--force", wtPath], {
        cwd: this.repoPath,
        logger: this.logger,
      });
      if (deleteBranch) {
        await runOk("git", ["branch", "-D", branchName(kind, number)], {
          cwd: this.repoPath,
          logger: this.logger,
        }).catch(() => {});
      }
      await runOk("git", ["worktree", "prune"], {
        cwd: this.repoPath,
        logger: this.logger,
      }).catch(() => {});
    });
  }

  async list(): Promise<{ branch: string; path: string }[]> {
    try {
      const result = await runOk(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: this.repoPath, logger: this.logger }
      );
      const worktrees: { branch: string; path: string }[] = [];
      let currentPath: string | undefined;
      for (const line of result.stdout.split("\n")) {
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
    } catch {
      return [];
    }
  }

  async hasUncommittedChanges(wtPath: string): Promise<boolean> {
    const result = await runOk(
      "git",
      ["status", "--porcelain"],
      { cwd: wtPath, logger: this.logger }
    );
    return result.stdout.trim().length > 0;
  }

  async commitAll(
    wtPath: string,
    message: string
  ): Promise<{ committed: boolean; summary: string }> {
    const status = await runOk("git", ["status", "--porcelain"], {
      cwd: wtPath,
      logger: this.logger,
    });
    if (!status.stdout.trim()) {
      return { committed: false, summary: "No changes to commit." };
    }
    await runOk("git", ["add", "-A"], { cwd: wtPath, logger: this.logger });
    await runOk("git", ["commit", "-m", message], {
      cwd: wtPath,
      logger: this.logger,
    });
    const log = await runOk("git", ["log", "-1", "--oneline"], {
      cwd: wtPath,
      logger: this.logger,
    });
    return { committed: true, summary: log.stdout.trim() };
  }

  async push(wtPath: string, branch: string): Promise<void> {
    await runOk("git", ["push", "-u", "origin", branch], {
      cwd: wtPath,
      logger: this.logger,
    });
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
      } catch {
        this.logger.warn(
          `Could not fetch head of PR #${number}; falling back to the current branch.`
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

  private async runEnvSetup(wtPath: string): Promise<void> {
    if (!this.envSetupCommand.trim()) {
      return;
    }
    this.logger.info(`Running env setup in ${wtPath}: ${this.envSetupCommand}`);
    const shell = process.platform === "win32" ? "cmd" : "sh";
    const shellArgs =
      process.platform === "win32"
        ? ["/c", this.envSetupCommand]
        : ["-c", this.envSetupCommand];
    await runOk(shell, shellArgs, {
      cwd: wtPath,
      logger: this.logger,
      env: { SWARMFORGE_WORKTREE: wtPath },
    }).catch((e) => {
      this.logger.warn(`Env setup failed: ${e instanceof Error ? e.message : e}`);
    });
  }
}
