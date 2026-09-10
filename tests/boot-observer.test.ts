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

afterEach(() => vi.useRealTimers());

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
  proc.stdout.emit("data", Buffer.from('{"id":2,"result":{}}\n'));
  proc.stdout.emit("data", Buffer.from('{"id":1,"res'));
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
    proc.stdout.emit("data", Buffer.from('{"id":1,"error":{"code":-1}}\n'));
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
    proc.stdout.emit("data", Buffer.from('{"id":1,"result":{}}\n'));
    proc.emit("close", null, "SIGKILL");
    return true;
  });
  expect(await observeBoot(proc, initializeRequest())).toMatchObject({ outcome: "ready" });
});
