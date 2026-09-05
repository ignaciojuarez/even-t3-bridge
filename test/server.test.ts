import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DEFAULTS } from "../src/config.ts";
import { T3Provider } from "../src/provider.ts";
import { startHttpServer } from "../src/server.ts";
import { T3Client } from "../src/t3.ts";
import { resetSseForTests } from "../src/sse.ts";

const TOKEN = "test-token";
const THREAD = {
  id: "thread-1",
  projectId: "proj-1",
  title: "Demo HUD",
  updatedAt: "2026-09-04T20:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: { status: "idle" },
  modelSelection: { instanceId: "cursor", model: "test-model" },
};

describe("even-terminal HTTP contract", () => {
  let t3Port = 0;
  let bridgePort = 0;
  let t3Server: ReturnType<typeof createServer>;
  let closeBridge: () => Promise<void>;
  let provider: T3Provider;
  const dispatched: unknown[] = [];

  before(async () => {
    resetSseForTests();
    t3Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.headers.authorization !== "Bearer t3-secret") {
        res.writeHead(401);
        res.end("no");
        return;
      }
      if (url.pathname === "/api/orchestration/shell") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            projects: [
              {
                id: THREAD.projectId,
                title: "Demo",
                workspaceRoot: "/tmp/demo",
              },
            ],
            threads: [THREAD],
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/api/orchestration/threads/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ thread: { ...THREAD, messages: [], activities: [] } }));
        return;
      }
      if (url.pathname === "/api/orchestration/dispatch" && req.method === "POST") {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => {
          dispatched.push(JSON.parse(buf));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sequence: 1 }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => t3Server.listen(0, "127.0.0.1", () => resolve()));
    const addr = t3Server.address();
    t3Port = typeof addr === "object" && addr ? addr.port : 0;

    const t3 = new T3Client(`http://127.0.0.1:${t3Port}`, "t3-secret");
    provider = T3Provider.fromClient(t3, {
      ...DEFAULTS,
      model: { instanceId: "cursor", model: "test-model" },
      port: 0,
      token: TOKEN,
      tailscale: false,
      host: null,
      name: "test",
      t3Token: "t3-secret",
    });
    const started = await startHttpServer(provider, {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      log: false,
    });
    bridgePort = started.port;
    closeBridge = started.close;
  });

  after(async () => {
    provider.stop();
    await closeBridge();
    await new Promise<void>((resolve) => t3Server.close(() => resolve()));
  });

  function api(path: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${bridgePort}${path}`, init);
  }

  it("rejects missing token", async () => {
    const res = await api("/api/sessions");
    assert.equal(res.status, 401);
  });

  it("lists T3 threads as codex sessions by default", async () => {
    const res = await api("/api/sessions?token=test-token");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: Array<{ id: string; provider: string; status: string }> };
    assert.equal(body.sessions[0]?.id, "thread-1");
    assert.equal(body.sessions[0]?.provider, "codex");
    assert.equal(body.sessions[0]?.status, "idle");
  });

  it("echoes provider=claude when the Even app asks for Claude Code", async () => {
    const res = await api("/api/sessions?token=test-token&provider=claude");
    const body = (await res.json()) as { sessions: Array<{ provider: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.sessions[0]?.provider, "claude");
  });

  it("pairing URL is 200", async () => {
    const res = await api("/?token=test-token&defaultProvider=claude&name=t3-bridge");
    assert.equal(res.status, 200);
  });

  it("health is open", async () => {
    const res = await api("/health");
    assert.equal(res.status, 200);
  });

  it("prompt follow-up dispatches thread.turn.start", async () => {
    const res = await api("/api/prompt", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "thread-1", text: "continue the review" }),
    });
    assert.equal(res.status, 202);
    const last = dispatched.at(-1) as { type: string; threadId: string };
    assert.equal(last.type, "thread.turn.start");
    assert.equal(last.threadId, "thread-1");
  });

  it("SSE greets and heartbeats headers", async () => {
    const res = await api("/api/events?sessionId=thread-1&token=test-token");
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /:ok/);
    await reader.cancel();
  });
});
