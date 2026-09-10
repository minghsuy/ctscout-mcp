/** Test-only stdio lifecycle observer. Readiness is a matching protocol response. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type BootOutcome = "ready" | "timeout" | "error" | "premature-close";
export interface BootResult {
  outcome: BootOutcome;
  elapsedMs: number;
  error?: { name: string; code?: string; message: string };
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  response?: Record<string, unknown>;
}

export function observeBoot(
  proc: ChildProcessWithoutNullStreams,
  request: { id: number; [key: string]: unknown },
): Promise<BootResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let error: BootResult["error"];
    let outcome: BootOutcome | undefined;
    let stdout = "";
    let stderr = "";
    let pending = "";
    let response: Record<string, unknown> | undefined;
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const stop = (reason: BootOutcome) => {
      if (outcome !== undefined) return;
      outcome = reason;
      clearTimeout(timer);
      // These are disposable test children, never production processes. Reap
      // even a stuck child; settlement still waits for close and drained pipes.
      proc.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), 3000);
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = outDecoder.write(chunk);
      stdout += text;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (
            typeof message === "object" &&
            message !== null &&
            "jsonrpc" in message &&
            message.jsonrpc === "2.0" &&
            "result" in message !== "error" in message &&
            "id" in message &&
            message.id === request.id
          ) {
            response = message as Record<string, unknown>;
            stop("result" in message ? "ready" : "error");
          }
        } catch {
          // Keep diagnostics, but malformed/nonmatching output is not readiness.
        }
        newline = pending.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += errDecoder.write(chunk);
    });
    const failed = (cause: unknown) => {
      const e = cause instanceof Error ? cause : new Error(String(cause));
      // Error messages can embed launch paths/arguments. Do not expose values
      // inherited from the test environment in assertion diagnostics.
      const redact = (text: string) => {
        for (const value of Object.values(process.env)) {
          if (value && value.length >= 4) text = text.replaceAll(value, "[redacted]");
        }
        return text;
      };
      const code = (e as NodeJS.ErrnoException).code;
      error ??= {
        name: redact(e.name),
        code: code === undefined ? undefined : redact(code),
        message: redact(e.message),
      };
      stop("error");
    };
    proc.on("error", failed);
    proc.stdin.on("error", failed);
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({
        elapsedMs: performance.now() - started,
        error,
        outcome: outcome ?? "premature-close",
        stdout,
        stderr,
        code,
        signal,
        response,
      });
    });
    // All handlers exist before the first write, including spawn and EPIPE errors.
    try {
      proc.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (cause) {
      failed(cause);
    }
  });
}

export function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-boot-regression", version: "0.0.1" },
    },
  };
}
