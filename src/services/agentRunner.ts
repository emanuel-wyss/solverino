import { ChildProcess, spawn } from "child_process";
import { Logger } from "../util";

export interface AgentJob {
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
}

export interface AgentEvents {
  onOutput(sessionId: string, chunk: string): void;
  onExit(sessionId: string, code: number | null): void;
}

interface QueuedJob {
  job: AgentJob;
  resolve: (code: number | null) => void;
  reject: (err: Error) => void;
}

export type StopResult = "killed" | "cancelled" | false;

export class AgentRunner {
  private maxConcurrent: number;
  private readonly running = new Map<string, ChildProcess>();
  private readonly queue: QueuedJob[] = [];
  private readonly stopped = new Set<string>();

  constructor(
    maxConcurrent: number,
    private readonly events: AgentEvents,
    private readonly logger: Logger
  ) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, max);
    this.drain();
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  isQueued(sessionId: string): boolean {
    return this.queue.some((q) => q.job.sessionId === sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.isRunning(sessionId) || this.isQueued(sessionId);
  }

  wasStopped(sessionId: string): boolean {
    return this.stopped.has(sessionId);
  }

  runningCount(): number {
    return this.running.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  run(job: AgentJob): Promise<number | null> {
    if (this.isActive(job.sessionId)) {
      return Promise.reject(
        new Error(`Agent already running or queued for ${job.sessionId}`)
      );
    }
    return new Promise<number | null>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.drain();
    });
  }

  stop(sessionId: string): StopResult {
    const child = this.running.get(sessionId);
    if (child) {
      this.stopped.add(sessionId);
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.running.get(sessionId) === child) {
          child.kill("SIGKILL");
        }
      }, 3000);
      timer.unref();
      return "killed";
    }
    const index = this.queue.findIndex(
      (q) => q.job.sessionId === sessionId
    );
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      this.stopped.add(sessionId);
      queued.resolve(null);
      this.events.onExit(sessionId, null);
      this.stopped.delete(sessionId);
      return "cancelled";
    }
    return false;
  }

  stopAll(): void {
    for (const sessionId of [...this.running.keys()]) {
      this.stop(sessionId);
    }
    while (this.queue.length > 0) {
      this.stop(this.queue[0].job.sessionId);
    }
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      this.start(next);
    }
  }

  private start(queued: QueuedJob): void {
    const { job } = queued;
    this.logger.info(
      `Starting agent for ${job.sessionId}: ${job.command} ${job.args.join(" ")}`
    );
    let child: ChildProcess;
    try {
      child = spawn(job.command, job.args, {
        cwd: job.cwd,
        env: process.env,
      });
    } catch (e) {
      queued.reject(
        new Error(
          `Failed to start "${job.command}". Is it installed and on PATH? (${
            e instanceof Error ? e.message : e
          })`
        )
      );
      this.drain();
      return;
    }
    this.running.set(job.sessionId, child);

    const forward = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) {
        return;
      }
      stream.on("data", (d: Buffer) => {
        this.events.onOutput(job.sessionId, d.toString());
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    child.on("error", (err) => {
      this.running.delete(job.sessionId);
      queued.reject(
        new Error(
          `Failed to start "${job.command}". Is it installed and on PATH? (${err.message})`
        )
      );
      this.drain();
    });

    child.on("close", (code) => {
      this.running.delete(job.sessionId);
      this.events.onExit(job.sessionId, code);
      this.stopped.delete(job.sessionId);
      queued.resolve(code);
      this.drain();
    });
  }
}

export function buildAgentArgs(
  prompt: string,
  resume: boolean,
  resumeArgs: string[]
): string[] {
  const args = ["-p", prompt];
  if (resume && resumeArgs.length > 0) {
    args.push(...resumeArgs);
  }
  return args;
}

export function buildDefaultPrompt(
  kind: "issue" | "pr",
  number: number,
  title: string,
  body: string
): string {
  const trimmedBody = body.slice(0, 4000);
  if (kind === "issue") {
    return [
      `Resolve GitHub issue #${number}: ${title}`,
      "",
      "Issue description:",
      trimmedBody,
      "",
      "Work in the repository this process is running in. Make the minimal correct change, follow the repository's existing style, and do not commit or push — leave the changes in the working tree for review.",
    ].join("\n");
  }
  return [
    `Address GitHub pull request #${number}: ${title}`,
    "",
    "Pull request description / context:",
    trimmedBody,
    "",
    "Work in the repository this process is running in. Make the minimal correct change, follow the repository's existing style, and do not commit or push — leave the changes in the working tree for review.",
  ].join("\n");
}
