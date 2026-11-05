import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { WorktreeService } from "../src/services/worktreeService";
import { branchName, sessionId, worktreeFolderName } from "../src/types";
import { PromiseQueue, runOk } from "../src/util";

describe("naming", () => {
  it("sessionId builds issue/pr ids", () => {
    assert.strictEqual(sessionId("issue", 42), "issue-42");
    assert.strictEqual(sessionId("pr", 7), "pr-7");
  });

  it("branchName builds issue/pr branches", () => {
    assert.strictEqual(branchName("issue", 42), "issue-42");
    assert.strictEqual(branchName("pr", 7), "pr-7");
  });

  it("worktreeFolderName includes repo, kind, number", () => {
    assert.strictEqual(
      worktreeFolderName("myrepo", "issue", 42),
      "swarmforge-myrepo-issue-42"
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
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "swarmforge-test-"));
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

  function makeService(envSetup = ""): WorktreeService {
    return new WorktreeService(repo, worktreeParent, envSetup, {
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
      path.join(worktreeParent, "swarmforge-repo-issue-42")
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

  it("detects uncommitted changes and commits them", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    assert.strictEqual(await svc.hasUncommittedChanges(info.path), false);
    fs.writeFileSync(path.join(info.path, "b.txt"), "new\n");
    assert.strictEqual(await svc.hasUncommittedChanges(info.path), true);
    const result = await svc.commitAll(info.path, "add b");
    assert.strictEqual(result.committed, true);
    assert.ok(result.summary.includes("add b"));
    assert.strictEqual(await svc.hasUncommittedChanges(info.path), false);
  });

  it("commitAll reports nothing to commit when clean", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    const result = await svc.commitAll(info.path, "noop");
    assert.strictEqual(result.committed, false);
  });

  it("removes worktree and branch", async () => {
    const svc = makeService();
    const info = await svc.ensure("issue", 42);
    await svc.remove("issue", 42);
    assert.ok(!fs.existsSync(info.path));
    const list = await svc.list();
    assert.ok(!list.some((w) => w.branch === "issue-42"));
  });

  it("runs env setup command in fresh worktree", async () => {
    const svc = makeService("touch envsetup-ran.txt");
    const info = await svc.ensure("pr", 7);
    assert.ok(
      fs.existsSync(path.join(info.path, "envsetup-ran.txt")),
      "env setup should have run in the worktree"
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
