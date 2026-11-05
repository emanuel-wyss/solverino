import * as assert from "assert";
import { AgentRunner, buildAgentArgs, buildDefaultPrompt } from "../src/services/agentRunner";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("buildAgentArgs", () => {
  it("builds prompt args", () => {
    assert.deepStrictEqual(buildAgentArgs("do work", false, ["--continue"]), [
      "-p",
      "do work",
    ]);
  });

  it("appends resume args when resuming", () => {
    assert.deepStrictEqual(buildAgentArgs("more work", true, ["--continue"]), [
      "-p",
      "more work",
      "--continue",
    ]);
  });
});

describe("buildDefaultPrompt", () => {
  it("includes issue number and title", () => {
    const prompt = buildDefaultPrompt("issue", 42, "Fix login", "Steps to reproduce…");
    assert.ok(prompt.includes("#42"));
    assert.ok(prompt.includes("Fix login"));
    assert.ok(prompt.includes("Steps to reproduce"));
  });

  it("labels PR prompts differently", () => {
    const prompt = buildDefaultPrompt("pr", 7, "Address review comments", "");
    assert.ok(prompt.includes("pull request #7"));
  });
});

describe("AgentRunner", () => {
  it("enforces the concurrency cap and queues jobs", async () => {
    const outputs: Array<{ sid: string; chunk: string }> = [];
    const exits: Array<{ sid: string; code: number | null }> = [];
    const runner = new AgentRunner(
      1,
      {
        onOutput: (sid, chunk) => outputs.push({ sid, chunk }),
        onExit: (sid, code) => exits.push({ sid, code }),
      },
      silentLogger
    );

    const job = (sessionId: string) => ({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi from ' + process.argv[1])", sessionId],
      cwd: process.cwd(),
      sessionId,
    });

    const results = await Promise.all([
      runner.run(job("issue-1")),
      runner.run(job("issue-2")),
    ]);

    assert.strictEqual(results[0], 0);
    assert.strictEqual(results[1], 0);
    assert.strictEqual(exits.length, 2);
    const chunks = outputs.map((o) => o.chunk).join("");
    assert.ok(chunks.includes("hi from issue-1"));
    assert.ok(chunks.includes("hi from issue-2"));
    assert.strictEqual(runner.runningCount(), 0);
    assert.strictEqual(runner.queuedCount(), 0);
  });

  it("reports exit code of failing agents", async () => {
    const exits: Array<{ sid: string; code: number | null }> = [];
    const runner = new AgentRunner(
      2,
      {
        onOutput: () => {},
        onExit: (sid, code) => exits.push({ sid, code }),
      },
      silentLogger
    );
    const code = await runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      sessionId: "issue-9",
    });
    assert.strictEqual(code, 3);
    assert.deepStrictEqual(exits, [{ sid: "issue-9", code: 3 }]);
  });

  it("rejects duplicate session runs", async () => {
    const runner = new AgentRunner(
      2,
      { onOutput: () => {}, onExit: () => {} },
      silentLogger
    );
    const job = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      cwd: process.cwd(),
      sessionId: "issue-5",
    };
    const first = runner.run(job);
    await assert.rejects(runner.run(job), /already running/);
    await first;
  });

  it("stop kills a running agent", async () => {
    const runner = new AgentRunner(
      2,
      { onOutput: () => {}, onExit: () => {} },
      silentLogger
    );
    const done = runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      cwd: process.cwd(),
      sessionId: "issue-6",
    });
    assert.strictEqual(runner.isRunning("issue-6"), true);
    assert.strictEqual(runner.stop("issue-6"), true);
    const code = await done;
    assert.notStrictEqual(code, 0);
    assert.strictEqual(runner.isRunning("issue-6"), false);
  });
});
