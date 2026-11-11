import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface NodeProcess {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  result?: Error;
  exited: boolean;
}

export function launch(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): NodeProcess {
  const fds: number[] = [];
  let child: ChildProcess;
  try {
    fds.push(openSync(join(cwd, `${label}.stdout.log`), "w", 0o600));
    fds.push(openSync(join(cwd, `${label}.stderr.log`), "w", 0o600));
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", ...fds],
    });
  } finally {
    fds.forEach(closeSync);
  }
  const task: NodeProcess = {
    child,
    exited: false,
    done: new Promise<void>((resolve) => {
      child.once("error", (error) => {
        task.result = error;
        task.exited = true;
        resolve();
      });
      child.once("exit", (code, signal) => {
        task.result = new Error(`${label} exited (${signal ?? code})`);
        task.exited = true;
        resolve();
      });
    }),
  };
  return task;
}

async function sessionProcesses(session: number): Promise<number[]> {
  const { stdout } = await exec("ps", ["-eo", "pid=,sid=,stat="], {
    timeout: 5000,
  });
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, sid, state] = line.trim().split(/\s+/);
      return Number(sid) === session && state && !state.startsWith("Z")
        ? [Number(pid)]
        : [];
    });
}

/** The backend uses a separate process group, but remains in the CLI session. */
export async function stop(task: NodeProcess): Promise<void> {
  const session = task.child.pid;
  if (!session) return;
  if (!task.exited) {
    task.child.kill("SIGTERM");
    const timer = new AbortController();
    try {
      await Promise.race([
        task.done,
        sleep(3000, undefined, { signal: timer.signal }),
      ]);
    } finally {
      timer.abort();
    }
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const deadline = performance.now() + 3000;
    do {
      const survivors = await sessionProcesses(session);
      if (!survivors.length) return;
      for (const pid of survivors) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await sleep(50);
    } while (performance.now() < deadline);
  }
  if ((await sessionProcesses(session)).length)
    throw new Error(`Could not stop node session ${session}`);
}

const owners = new Set<(reason: Error) => Promise<void>>();
let interrupting = false;
async function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interrupting) return;
  interrupting = true;
  const results = await Promise.allSettled(
    [...owners].map((close) =>
      close(new Error(`Scenario interrupted by ${signal}`)),
    ),
  );
  for (const result of results)
    if (result.status === "rejected") console.error(result.reason);
  interrupting = false;
  // Preserve normal signal exit when the application has no handler of its own.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
const onInterrupt = () => {
  void interrupt("SIGINT");
};
const onTerminate = () => {
  void interrupt("SIGTERM");
};

export function ownProcesses(
  close: (reason: Error) => Promise<void>,
): () => void {
  if (!owners.size) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  owners.add(close);
  return () => {
    owners.delete(close);
    if (!owners.size) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  };
}
