import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_EXTENSION = join(ROOT, "test", "fixtures", "completion-provider.ts");
const COMPLETION_EXTENSION = join(ROOT, "pi-extension", "subagents", "subagent-done.ts");
const TIMEOUT_MS = 10_000;
// npm scripts prepend the repository's older Pi dev dependency. These tests
// exercise the installed CLI, unless an explicit executable is supplied.
const RUNTIME_PATH = (process.env.PATH ?? "").split(delimiter)
  .filter((entry) => resolve(entry) !== join(ROOT, "node_modules", ".bin"))
  .join(delimiter);
const tempDirs = new Set<string>();

type RpcRecord = Record<string, any>;

class RpcRuntime {
  readonly records: RpcRecord[] = [];
  readonly sessionFile: string;
  readonly providerLog: string;
  readonly dir: string;

  private child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private waiters = new Set<() => void>();
  private nextRequestId = 1;
  private exited = false;
  private exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(scenario: string, completionMode = "task") {
    this.dir = mkdtempSync(join(tmpdir(), "pi-completion-runtime-"));
    tempDirs.add(this.dir);
    const agentDir = join(this.dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    this.sessionFile = join(this.dir, "session.jsonl");
    this.providerLog = join(this.dir, "provider-requests.log");
    if (scenario === "user-fork") {
      const parentFile = join(this.dir, "parent.jsonl");
      writeFileSync(parentFile, [
        { type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: this.dir },
        { type: "message", id: "request", parentId: null, message: { role: "user", content: [{ type: "text", text: "Get up to speed on contracts." }], timestamp: Date.now() } },
        { type: "message", id: "completed", parentId: "request", message: {
          role: "assistant", content: [{ type: "text", text: "Onboarding is complete. All three scouts returned." }],
          api: "completion-fixture-api", provider: "completion-fixture", model: "scripted", stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      seedSubagentSessionFile({ mode: "fork", parentSessionFile: parentFile, childSessionFile: this.sessionFile, childCwd: this.dir, forkFromEntryId: "completed" });
    }
    this.exitPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit;
    });

    const env: NodeJS.ProcessEnv = {
      PATH: RUNTIME_PATH,
      HOME: this.dir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SUBAGENT_SESSION: this.sessionFile,
      PI_SUBAGENT_COMPLETION_MODE: completionMode,
      PI_COMPLETION_FIXTURE_SCENARIO: scenario,
      PI_COMPLETION_FIXTURE_LOG: this.providerLog,
    };

    this.child = spawn(
      process.env.PI_TEST_PI ?? "pi",
      [
        "--mode", "rpc",
        "--no-extensions",
        "--no-builtin-tools",
        "--no-approve",
        "--extension", PROVIDER_EXTENSION,
        "--extension", COMPLETION_EXTENSION,
        "--provider", "completion-fixture",
        "--model", "scripted",
        "--session", this.sessionFile,
      ],
      { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] },
    );

    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => {
      this.stderr += `\nspawn error: ${error.message}`;
    });
    this.child.on("close", (code, signal) => {
      this.exited = true;
      this.exitResult = { code, signal };
      this.exitResolve(this.exitResult);
      this.notifyWaiters();
    });
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  send(command: RpcRecord): void {
    assert.equal(this.exited, false, `pi exited before command: ${this.diagnostics()}`);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async request(command: RpcRecord): Promise<RpcRecord> {
    const id = `test-${this.nextRequestId++}`;
    const response = this.waitFor(
      (record) => record.type === "response" && record.id === id,
      `response to ${command.type}`,
    );
    this.send({ ...command, id });
    const record = await response;
    assert.equal(record.success, true, `RPC ${command.type} failed: ${JSON.stringify(record)}`);
    return record;
  }

  async waitForCount(type: string, count: number): Promise<void> {
    await this.waitFor(
      () => this.records.filter((record) => record.type === type).length >= count,
      `${count} ${type} event(s)`,
    );
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolveExit, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for pi exit. ${this.diagnostics()}`)),
        TIMEOUT_MS,
      );
      this.exitPromise.then((result) => {
        clearTimeout(timeout);
        resolveExit(result);
      });
    });
  }

  providerRequests(): Array<{ request: number; completionChecks: number }> {
    try {
      return readFileSync(this.providerLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  providerRequestCount(): number {
    return this.providerRequests().length;
  }

  async stop(): Promise<void> {
    if (!this.exited) this.child.kill("SIGTERM");
    await this.exitPromise;
    rmSync(this.dir, { recursive: true, force: true });
    tempDirs.delete(this.dir);
  }

  private waitFor(predicate: (record: RpcRecord) => boolean, description: string): Promise<RpcRecord> {
    const existing = this.records.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolveRecord, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for ${description}. ${this.diagnostics()}`));
      }, TIMEOUT_MS);
      const check = () => {
        const match = this.records.find(predicate);
        if (match) {
          clearTimeout(timeout);
          this.waiters.delete(check);
          resolveRecord(match);
        } else if (this.exited) {
          clearTimeout(timeout);
          this.waiters.delete(check);
          reject(new Error(`pi exited while waiting for ${description}. ${this.diagnostics()}`));
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        this.records.push(JSON.parse(line));
      } catch (error) {
        this.stderr += `\ninvalid RPC JSONL ${JSON.stringify(line)}: ${String(error)}`;
      }
      this.notifyWaiters();
    }
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private diagnostics(): string {
    return `exit=${JSON.stringify(this.exitResult)} stderr=${JSON.stringify(this.stderr)} records=${JSON.stringify(this.records.slice(-8))}`;
  }
}

after(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sidecar(runtime: RpcRuntime): RpcRecord {
  return JSON.parse(readFileSync(`${runtime.sessionFile}.exit`, "utf8"));
}

describe("subagent completion protocol through Pi 0.85 RPC runtime", { concurrency: false }, () => {
  it("keeps a user-driven fork of completed work open without a completion reminder", async (t) => {
    const runtime = new RpcRuntime("user-fork", "user");
    t.after(() => runtime.stop());
    await runtime.request({ type: "prompt", message: "The user wants to do some hands-on work. Help them with whatever they need." });
    await runtime.waitForCount("agent_settled", 1);
    const state = await runtime.request({ type: "get_state" });
    assert.equal(runtime.exitCode, null);
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.pendingMessageCount, 0);
    assert.deepEqual(runtime.providerRequests(), [{
      request: 1, completionChecks: 0, tools: [], inheritedSummary: true, userDrivenInstructions: true,
    }]);
    assert.equal(existsSync(`${runtime.sessionFile}.exit`), false);
    const entries = readFileSync(runtime.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.customType === "subagent_lifecycle" && entry.data.completionMode === "user"));

    await runtime.request({ type: "prompt", message: "I want to discuss editing contracts." });
    await runtime.waitForCount("agent_settled", 2);
    const resumed = await runtime.request({ type: "get_state" });
    assert.equal(resumed.data.isStreaming, false);
    assert.equal(resumed.data.pendingMessageCount, 0);
    assert.equal(runtime.providerRequestCount(), 2);
    assert.equal(existsSync(`${runtime.sessionFile}.exit`), false);
  });

  it("ends on explicit summary completion without another provider inference", async (t) => {
    const runtime = new RpcRuntime("explicit-summary");
    t.after(() => runtime.stop());

    await runtime.request({ type: "prompt", message: "complete explicitly" });
    const exit = await runtime.waitForExit();

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(runtime.providerRequestCount(), 1);
    assert.deepEqual(sidecar(runtime), { type: "done", summary: "explicit runtime handoff" });
  });

  it("sends one completion reminder after an unmarked stop, then accepts completion", async (t) => {
    const runtime = new RpcRuntime("reminder-completes");
    t.after(() => runtime.stop());

    await runtime.request({ type: "prompt", message: "forget the marker once" });
    const exit = await runtime.waitForExit();

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(runtime.providerRequestCount(), 2);
    assert.equal(runtime.records.filter((record) => record.type === "agent_start").length, 2);
    assert.deepEqual(sidecar(runtime), { type: "done", summary: "completed after one reminder" });

    assert.deepEqual(runtime.providerRequests(), [
      { request: 1, completionChecks: 0 },
      { request: 2, completionChecks: 1 },
    ]);
  });

  it("keeps an intentional wait open and completes after a second RPC prompt", async (t) => {
    const runtime = new RpcRuntime("wait-resume");
    t.after(() => runtime.stop());

    await runtime.request({ type: "prompt", message: "wait for more input" });
    await runtime.waitForCount("agent_settled", 1);
    const waitingState = await runtime.request({ type: "get_state" });

    assert.equal(runtime.exitCode, null);
    assert.equal(runtime.providerRequestCount(), 1);
    assert.equal(waitingState.data.isStreaming, false);
    assert.equal(waitingState.data.pendingMessageCount, 0);
    assert.equal(existsSync(`${runtime.sessionFile}.exit`), false);

    await runtime.request({ type: "prompt", message: "the required input is now available" });
    const exit = await runtime.waitForExit();

    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(runtime.providerRequestCount(), 2);
    assert.deepEqual(sidecar(runtime), { type: "done", summary: "completed after RPC resume" });
  });

  it("does not loop when the one reminder also receives unmarked text", async (t) => {
    const runtime = new RpcRuntime("bounded-reminder");
    t.after(() => runtime.stop());

    await runtime.request({ type: "prompt", message: "repeat an unmarked answer" });
    await runtime.waitForCount("agent_settled", 2);
    const state = await runtime.request({ type: "get_state" });

    assert.equal(runtime.exitCode, null);
    assert.deepEqual(runtime.providerRequests(), [
      { request: 1, completionChecks: 0 },
      { request: 2, completionChecks: 1 },
    ]);
    assert.equal(runtime.records.filter((record) => record.type === "agent_start").length, 2);
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.pendingMessageCount, 0);
    assert.equal(existsSync(`${runtime.sessionFile}.exit`), false);
  });
});
