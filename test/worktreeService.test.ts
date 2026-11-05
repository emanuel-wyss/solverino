import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { WorktreeService } from "../src/services/worktreeService";
import { branchName, worktreeFolderName } from "../src/types";
import { PromiseQueue, runOk } from "../src/util";

describe("naming", () => {
  it("branchName builds issue/pr branches", () => {
    assert.strictEqual(branchName("issue", 42), "issue-42");
    assert.strictEqual(branchName("pr", 7), "pr-7");
  });

  it("worktreeFolderName includes repo, kind, number", () => {
    assert.strictEqual(
      worktreeFolderName("myrepo", "issue", 42),
      "solverino-myrepo-issue-42"
    );
  });
});

describe("PromiseQueue", () => {
  it("serializes tasks", async () => {
    const order: number[] = [];
    const queue = new PromiseQueue();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      queue.serialize(async () => {
        await sleep(30);
        order.push(1);
      }),
      queue.serialize(async () => {
        order.push(2);
      }),
      queue.serialize(async () => {
        await sleep(5);
        order.push(3);
      }),
    ]);
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("continues after a failure", async () => {
    const queue = new PromiseQueue();
    const first = queue.serialize(async () => {
      throw new Error("boom");
    });
    const second = queue.serialize(async () => "ok");
    await assert.rejects(first, /boom/);
    assert.strictEqual(await second, "ok");
  });
});

describe("WorktreeService", () => {
  let repo: string;
  let worktreeParent: string;

  function git(args: string[], cwd: string): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  beforeEach("create temp repo", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "solverino-test-"));
    repo = path.join(base, "repo");
    worktreeParent = path.join(base, "worktrees");
    fs.mkdirSync(repo);
    fs.mkdirSync(worktreeParent);
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "test@test"], repo);
    git(["config", "user.name", "test"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
  });

  afterEach("cleanup temp repo", () => {
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  function makeService(): WorktreeService {
    return new WorktreeService(repo, worktreeParent, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  }

  it("creates a worktree with the expected branch and path", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    assert.strictEqual(info.branch, "issue-42");
    assert.strictEqual(
      info.path,
      path.join(worktreeParent, "solverino-repo-issue-42")
    );
    assert.ok(fs.existsSync(path.join(info.path, "a.txt")));
    assert.strictEqual(info.created, true);
  });

  it("is idempotent on second ensure", async () => {
    const svc = makeService();
    const first = await svc.ensure("issue", 42);
    const second = await svc.ensure("issue", 42);
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.path, first.path);
  });

  it("lists created worktrees", async () => {
    const svc = makeService();
    await svc.ensure("issue", 42);
    const list = await svc.list();
    assert.ok(list.some((w) => w.branch === "issue-42"));
  });

  it("removes worktree and branch", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    await svc.remove("issue", 42);
    assert.ok(!fs.existsSync(info.path));
    const list = await svc.list();
    assert.ok(!list.some((w) => w.branch === "issue-42"));
  });

  it("statusFiles lists changed files", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    fs.writeFileSync(path.join(info.path, "src.ts"), "x\n");
    const status = await svc.statusFiles(info.path);
    assert.ok(status.files.some((f) => f.endsWith("src.ts")));
  });

  it("unpushedCommitCount counts commits not on any remote", async () => {
    const base = path.dirname(repo);
    const remote = path.join(base, "remote.git");
    fs.mkdirSync(remote);
    git(["init", "--bare", "-b", "main"], remote);
    git(["remote", "add", "origin", remote], repo);
    git(["push", "-u", "origin", "main"], repo);

    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    assert.strictEqual(await svc.unpushedCommitCount(info.path, "issue-42"), 0);
    fs.writeFileSync(path.join(info.path, "b.txt"), "new\n");
    git(["add", "-A"], info.path);
    git(["commit", "-m", "work"], info.path);
    assert.strictEqual(await svc.unpushedCommitCount(info.path, "issue-42"), 1);
  });

  it("checks out the actual PR head branch when given", async () => {
    const base = path.dirname(repo);
    const remote = path.join(base, "remote.git");
    fs.mkdirSync(remote);
    git(["init", "--bare", "-b", "main"], remote);
    git(["remote", "add", "origin", remote], repo);
    git(["push", "-u", "origin", "main"], repo);

    git(["checkout", "-b", "feature-branch"], repo);
    fs.writeFileSync(path.join(repo, "pr-change.txt"), "change\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "pr work"], repo);
    git(["push", "origin", "feature-branch"], repo);
    const headSha = git(["rev-parse", "HEAD"], repo).trim();
    git(["update-ref", "refs/pull/7/head", headSha], remote);
    git(["checkout", "main"], repo);

    const svc = makeService();
    const info = await svc.ensure("pr", 7, "feature-branch");
    assert.strictEqual(info.branch, "feature-branch");
    assert.ok(fs.existsSync(path.join(info.path, "pr-change.txt")));
    const checkedOut = git(["rev-parse", "--abbrev-ref", "HEAD"], info.path).trim();
    assert.strictEqual(checkedOut, "feature-branch");
  });

  it("rejects an existing worktree registered on a different branch", async () => {
    const svc = makeService();
    const conflictingPath = path.join(
      worktreeParent,
      "solverino-repo-issue-42"
    );
    git(["worktree", "add", "-b", "someone-else", conflictingPath], repo);
    await assert.rejects(
      svc.ensure("issue", 42),
      /registered on branch "someone-else"/
    );
  });

  it("dirtyFileCount counts tracked and untracked changes individually", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    assert.strictEqual(await svc.dirtyFileCount(info.path), 0);
    fs.writeFileSync(path.join(info.path, "a.txt"), "changed\n");
    fs.mkdirSync(path.join(info.path, "new-dir", "nested"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(info.path, "new-dir", "one.txt"), "1\n");
    fs.writeFileSync(path.join(info.path, "new-dir", "two.txt"), "2\n");
    fs.writeFileSync(
      path.join(info.path, "new-dir", "nested", "three.txt"),
      "3\n"
    );
    assert.strictEqual(await svc.dirtyFileCount(info.path), 4);
  });

  it("refuses to create a PR worktree when the PR head cannot be fetched", async () => {
    const base = path.dirname(repo);
    const remote = path.join(base, "remote.git");
    fs.mkdirSync(remote);
    git(["init", "--bare", "-b", "main"], remote);
    git(["remote", "add", "origin", remote], repo);

    const svc = makeService();
    await assert.rejects(
      svc.ensure("pr", 7),
      /refusing to build the worktree from unrelated code/
    );
  });
});

describe("runOk", () => {
  it("rejects with RunError on non-zero exit", async () => {
    await assert.rejects(
      runOk("git", ["rev-parse", "--verify", "definitely-not-a-ref"], {
        cwd: process.cwd(),
      }),
      /exited with code/
    );
  });
});
