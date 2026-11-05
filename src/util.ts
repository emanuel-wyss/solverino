export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class RunError extends Error {
  constructor(
    public readonly command: string,
    public readonly result: RunResult
  ) {
    super(
      `${command} exited with code ${result.code}` +
        (result.stderr.trim() ? `: ${result.stderr.trim().split("\n").pop()}` : "")
    );
    this.name = "RunError";
  }
}

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; logger?: Logger; env?: Record<string, string> } = {}
): Promise<RunResult> {
  const { spawn } = await import("child_process");
  options.logger?.debug(`$ ${command} ${args.join(" ")}`);
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(
        new Error(
          `Failed to start "${command}". Is it installed and on PATH? (${err.message})`
        )
      )
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr })
    );
  });
}

export async function runOk(
  command: string,
  args: string[],
  options: { cwd?: string; logger?: Logger; env?: Record<string, string> } = {}
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new RunError(`${command} ${args.join(" ")}`, result);
  }
  return result;
}

export class PromiseQueue {
  private tail: Promise<unknown> = Promise.resolve();

  serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}
