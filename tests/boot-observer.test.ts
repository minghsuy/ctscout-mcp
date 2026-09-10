import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { initializeRequest, observeBoot } from "./boot-observer.js";

function child() {
  const events = new EventEmitter();
  return Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("timeout waits for close and preserves late stderr, repeatedly", async () => {
  vi.useFakeTimers();
  for (let schedule = 0; schedule < 3; schedule++) {
    const proc = child();
    let settled = false;
    const result = observeBoot(proc, initializeRequest()).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    proc.stderr.emit("data", Buffer.from("late buffered diagnostic"));
    proc.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    await Promise.resolve();
    expect(settled).toBe(false);
    proc.emit("close", null, "SIGKILL");
    expect(await result).toMatchObject({
      outcome: "timeout",
      stderr: "late buffered diagnostic",
      signal: "SIGKILL",
    });
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("normal close drains diagnostics and reports the guard-style exit", async () => {
  const proc = child();
  const result = observeBoot(proc, initializeRequest());
  proc.stderr.emit("data", Buffer.from("diagnostic"));
  proc.emit("close", 0, null);
  expect(await result).toMatchObject({ outcome: "premature-close", code: 0, stderr: "diagnostic" });
  expect(proc.kill).not.toHaveBeenCalled();
});

it("a banner or other request reply is not readiness; split matching reply is", async () => {
  const proc = child();
  let settled = false;
  const result = observeBoot(proc, initializeRequest()).then((value) => {
    settled = true;
    return value;
  });
  proc.stderr.emit("data", Buffer.from("running via stdio"));
  for (const message of [
    { id: 1, result: {} },
    { jsonrpc: "1.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 1, result: {}, error: {} },
    { jsonrpc: "2.0", id: 1, method: "notification" },
  ])
    proc.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  expect(proc.kill).not.toHaveBeenCalled();
  proc.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
  proc.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"res'));
  expect(proc.kill).not.toHaveBeenCalled();
  proc.stdout.emit("data", Buffer.from('ult":{"serverInfo":{}}}\n'));
  expect(proc.kill).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(settled).toBe(false);
  proc.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({
    outcome: "ready",
    response: { id: 1, result: { serverInfo: {} } },
  });
});

it.each(["child", "stdin", "protocol"])("%s failure waits for close", async (source) => {
  const proc = child();
  let settled = false;
  const result = observeBoot(proc, initializeRequest()).then((value) => {
    settled = true;
    return value;
  });
  if (source === "protocol")
    proc.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}\n'));
  else (source === "stdin" ? proc.stdin : proc).emit("error", new Error("fixture failure"));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(proc.kill).toHaveBeenCalledOnce();
  proc.emit("close", 1, null);
  expect(await result).toMatchObject({ outcome: "error", code: 1 });
});

it("installs output/error handlers before writing initialize", async () => {
  const proc = child();
  vi.spyOn(proc.stdin, "write").mockImplementation(() => {
    proc.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    proc.emit("close", null, "SIGKILL");
    return true;
  });
  expect(await observeBoot(proc, initializeRequest())).toMatchObject({ outcome: "ready" });
});

it.each([
  "child",
  "stdin",
  "write",
])("retains %s error cause and elapsed time with secret redaction", async (source) => {
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(175);
  vi.stubEnv("CTSCOUT_API_KEY", "synthetic-secret-do-not-print");
  const proc = child();
  const cause = Object.assign(new Error("failed synthetic-secret-do-not-print"), { code: "EPIPE" });
  if (source === "write")
    vi.spyOn(proc.stdin, "write").mockImplementation(() => {
      throw cause;
    });
  const result = observeBoot(proc, initializeRequest());
  if (source !== "write") (source === "stdin" ? proc.stdin : proc).emit("error", cause);
  proc.emit("close", -2, null);
  expect(await result).toMatchObject({
    outcome: "error",
    elapsedMs: 75,
    error: { name: "Error", code: "EPIPE", message: "failed [redacted]" },
  });
});
