import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  answersFromPending,
  decodeSessionId,
  deltaSince,
  derivePendingRequests,
  emitAssistantText,
  encodeSessionId,
  latestAssistantText,
  mapDecision,
  parseNewPrompt,
  resolveProject,
  sessionStateFromThread,
} from "../src/logic.ts";
import type { EvenMessage } from "../src/types.ts";

describe("sessionStateFromThread", () => {
  it("maps pending approval to awaiting", () => {
    assert.equal(
      sessionStateFromThread({
        id: "t",
        projectId: "p",
        title: "x",
        hasPendingApprovals: true,
      }),
      "awaiting",
    );
  });

  it("maps running session to busy", () => {
    assert.equal(
      sessionStateFromThread({
        id: "t",
        projectId: "p",
        title: "x",
        session: { status: "running" },
      }),
      "busy",
    );
  });

  it("defaults to idle", () => {
    assert.equal(sessionStateFromThread({ id: "t", projectId: "p", title: "x" }), "idle");
  });
});

describe("parseNewPrompt", () => {
  const aliases = ["demo", "my-app", "my app"];

  it("parses new in demo with remainder", () => {
    assert.deepEqual(parseNewPrompt("new in demo fix the login", "sess", aliases), {
      create: true,
      envHint: null,
      projectHint: "demo",
      text: "fix the login",
    });
  });

  it("parses multi-word project title", () => {
    assert.deepEqual(parseNewPrompt("new in my app reboot t3", undefined, aliases), {
      create: true,
      envHint: null,
      projectHint: "my app",
      text: "reboot t3",
    });
  });

  it("parses new in studio demo", () => {
    assert.deepEqual(
      parseNewPrompt("new in studio demo fix the login", undefined, ["demo"], ["local", "studio"]),
      {
        create: true,
        envHint: "studio",
        projectHint: "demo",
        text: "fix the login",
      },
    );
  });

  it("follow-up stays on the session", () => {
    assert.deepEqual(parseNewPrompt("keep going", "sess", aliases), {
      create: false,
      envHint: null,
      projectHint: null,
      text: "keep going",
    });
  });

  it("creates when there is no session", () => {
    assert.deepEqual(parseNewPrompt("look at the feed", undefined, aliases), {
      create: true,
      envHint: null,
      projectHint: null,
      text: "look at the feed",
    });
  });
});

describe("session ids", () => {
  it("keeps local threads as raw uuids", () => {
    const id = "3c2b1a09-1111-2222-3333-444455556666";
    assert.equal(encodeSessionId("local", id), id);
    assert.deepEqual(decodeSessionId(id, ["local", "studio"]), { envId: "local", threadId: id });
  });

  it("prefixes remote threads", () => {
    const id = "3c2b1a09-1111-2222-3333-444455556666";
    assert.equal(encodeSessionId("studio", id), `studio:${id}`);
    assert.deepEqual(decodeSessionId(`studio:${id}`, ["local", "studio"]), {
      envId: "studio",
      threadId: id,
    });
  });
});

describe("resolveProject", () => {
  const projects = [{ id: "abc", title: "Demo", workspaceRoot: "/tmp/demo" }];

  it("matches T3 project title", () => {
    assert.equal(resolveProject("demo", projects, "").id, "abc");
  });

  it("throws on unknown hint", () => {
    assert.throws(() => resolveProject("missing", projects, "demo"), /not found/);
  });
});

describe("text helpers", () => {
  it("returns latest assistant and incremental delta", () => {
    const text = latestAssistantText([
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello" },
      { role: "assistant", text: "Hello world" },
    ]);
    assert.equal(text, "Hello world");
    assert.equal(deltaSince("Hello", "Hello world"), " world");
    assert.equal(deltaSince("", "Hello"), "Hello");
  });
});

describe("derivePendingRequests", () => {
  it("keeps open approvals and drops resolved ones", () => {
    const pending = derivePendingRequests([
      {
        kind: "approval.requested",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Command approval requested",
        payload: { requestId: "req-1", requestKind: "command", detail: "bun run lint" },
      },
      {
        kind: "approval.requested",
        createdAt: "2026-02-23T00:00:01.500Z",
        summary: "File-change approval requested",
        payload: { requestId: "req-2", requestKind: "file-change" },
      },
      {
        kind: "approval.resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        payload: { requestId: "req-2" },
      },
    ]);
    assert.deepEqual(pending, [
      {
        requestId: "req-1",
        kind: "approval",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
        summary: "Command approval requested",
      },
    ]);
  });

  it("tracks user-input.requested", () => {
    const pending = derivePendingRequests([
      {
        kind: "user-input.requested",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Which target?",
        payload: {
          requestId: "q-1",
          detail: "device or sim",
          questions: [{ id: "device", question: "Which target?", header: "Target" }],
        },
      },
    ]);
    assert.equal(pending[0]?.kind, "user-input");
    assert.equal(pending[0]?.requestId, "q-1");
    assert.equal(pending[0]?.questions?.[0]?.id, "device");
    assert.deepEqual(answersFromPending(pending[0]!, "sim"), {
      answer: "sim",
      device: "sim",
    });
  });

  it("clears stale respond.failed", () => {
    const pending = derivePendingRequests([
      {
        kind: "approval.requested",
        createdAt: "t1",
        payload: { requestId: "req-1" },
      },
      {
        kind: "provider.approval.respond.failed",
        createdAt: "t2",
        payload: { requestId: "req-1", detail: "unknown approval request" },
      },
    ]);
    assert.equal(pending.length, 0);
  });
});

const GOLDEN = [
  { type: "status", state: "text_start", sessionId: "sess-1" },
  { type: "text_delta", text: "Done." },
  { type: "status", state: "text_end", sessionId: "sess-1" },
  {
    type: "result",
    success: true,
    text: "Done.",
    sessionId: "sess-1",
    costUsd: 0,
    provider: "codex",
    turns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  },
] as const;

describe("emitAssistantText", () => {
  it("emits the firmware paint-and-persist sequence", () => {
    const frames: EvenMessage[] = [];
    emitAssistantText((id, msg) => {
      assert.equal(id, "sess-1");
      frames.push(msg);
    }, "sess-1", "Done.");
    assert.deepEqual(frames, GOLDEN);
  });
});

describe("mapDecision", () => {
  it("maps even-terminal keys onto T3 decisions", () => {
    assert.equal(mapDecision("allow"), "accept");
    assert.equal(mapDecision("allowAlways"), "acceptForSession");
    assert.equal(mapDecision("deny"), "decline");
    assert.equal(mapDecision(undefined), "decline");
  });
});
