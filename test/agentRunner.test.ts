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

  it("cancels a queued agent before it starts", async () => {
    const exits: Array<{ sid: string; code: number | null }> = [];
    const runner = new AgentRunner(
      1,
      {
        onOutput: () => {},
        onExit: (sid, code) => exits.push({ sid, code }),
      },
      silentLogger
    );
    const blocking = runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 300)"],
      cwd: process.cwd(),
      sessionId: "issue-1",
    });
    const queued = runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      sessionId: "issue-2",
    });
    assert.strictEqual(runner.isQueued("issue-2"), true);
    assert.strictEqual(runner.stop("issue-2"), "cancelled");
    assert.strictEqual(await queued, null);
    assert.deepStrictEqual(exits, [{ sid: "issue-2", code: null }]);
    await blocking;
    assert.strictEqual(runner.isQueued("issue-2"), false);
  });

  it("rejects duplicate starts for queued sessions", async () => {
    const runner = new AgentRunner(
      1,
      { onOutput: () => {}, onExit: () => {} },
      silentLogger
    );
    const first = runner.run({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 200)"],
      cwd: process.cwd(),
      sessionId: "issue-3",
    });
    assert.strictEqual(runner.isQueued("issue-3"), false);
    const queued = runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      sessionId: "issue-4",
    });
    assert.strictEqual(runner.isQueued("issue-4"), true);
    await assert.rejects(
      runner.run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        sessionId: "issue-4",
      }),
      /running or queued/
    );
    runner.stop("issue-4");
    await queued;
    await first;
  });

  it("stop terminates spawned worker processes too", async () => {
    const outputs: string[] = [];
    const runner = new AgentRunner(
      2,
      {
        onOutput: (_sid, chunk) => outputs.push(chunk),
        onExit: () => {},
      },
      silentLogger
    );
    const workerScript = "setTimeout(() => process.exit(0), 60000);";
    const agentScript = `
      const { spawn } = require('child_process');
      const worker = spawn(process.execPath, ['-e', ${JSON.stringify(
        workerScript
      )}], { stdio: 'ignore' });
      console.log('WORKER:' + worker.pid);
      process.on('SIGTERM', () => {});
      setTimeout(() => process.exit(0), 60000);
    `;
    const done = runner.run({
      command: process.execPath,
      args: ["-e", agentScript],
      cwd: process.cwd(),
      sessionId: "issue-7",
    });
    const deadline = Date.now() + 5000;
    let workerPid: number | undefined;
    while (Date.now() < deadline && !workerPid) {
      await new Promise((r) => setTimeout(r, 50));
      for (const chunk of outputs) {
        const match = chunk.match(/WORKER:(\d+)/);
        if (match) {
          workerPid = Number(match[1]);
        }
      }
    }
    assert.ok(workerPid, "agent should print its worker pid");
    assert.strictEqual(runner.stop("issue-7"), "killed");
    await done;
    await new Promise((r) => setTimeout(r, 500));
    let workerAlive = true;
    try {
      process.kill(workerPid!, 0);
    } catch {
      workerAlive = false;
    }
    assert.strictEqual(
      workerAlive,
      false,
      "worker process should have been terminated with the agent"
    );
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
    assert.strictEqual(runner.stop("issue-6"), "killed");
    const code = await done;
    assert.notStrictEqual(code, 0);
    assert.strictEqual(runner.isRunning("issue-6"), false);
  });
});
