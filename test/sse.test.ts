import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  addClient,
  emit,
  getMessages,
  resetSseForTests,
} from "../src/sse.ts";
import type { ServerResponse } from "node:http";

function fakeRes() {
  const chunks: string[] = [];
  const res = new EventEmitter() as EventEmitter & {
    write: (s: string) => boolean;
    chunks: string[];
  };
  res.write = (s: string) => {
    chunks.push(s);
    return true;
  };
  res.chunks = chunks;
  return res as unknown as ServerResponse & { chunks: string[] };
}

describe("sse ring", () => {
  beforeEach(() => resetSseForTests());

  it("stores frames and replays after Last-Event-ID", () => {
    emit("s1", { type: "status", state: "busy", sessionId: "s1" });
    emit("s1", { type: "text_delta", text: "Hi" });
    assert.equal(getMessages("s1", 0).length, 2);

    const res = fakeRes();
    addClient("s1", res, { lastEventId: 1 });
    assert.match(res.chunks.join(""), /text_delta/);
    assert.doesNotMatch(res.chunks.join(""), /"busy"/);
  });

  it("needReplay sends the whole ring", () => {
    emit("s1", { type: "user_prompt", text: "go" });
    const res = fakeRes();
    addClient("s1", res, { needReplay: true });
    assert.match(res.chunks.join(""), /user_prompt/);
  });
});
