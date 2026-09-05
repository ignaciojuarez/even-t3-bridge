import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DEFAULTS } from "../src/config.ts";
import { T3Provider } from "../src/provider.ts";

function fakeT3(project: string, thread: { id: string; title: string; updatedAt: string }) {
  const server = createServer((req, res) => {
    if (req.url === "/api/orchestration/shell") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          projects: [{ id: `${project}-id`, title: project, workspaceRoot: `/tmp/${project}` }],
          threads: [
            {
              ...thread,
              projectId: `${project}-id`,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              session: { status: "idle" },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

describe("multi-env session list", () => {
  const local = fakeT3("Demo", {
    id: "local-thread",
    title: "HUD",
    updatedAt: "2026-09-04T21:00:00.000Z",
  });
  const remote = fakeT3("Other", {
    id: "remote-thread",
    title: "Review",
    updatedAt: "2026-09-04T22:00:00.000Z",
  });
  let provider: T3Provider;

  before(async () => {
    const localPort = await listen(local);
    const remotePort = await listen(remote);
    provider = new T3Provider(
      [
        { id: "local", origin: `http://127.0.0.1:${localPort}`, token: "x", defaultProject: "Demo" },
        { id: "studio", origin: `http://127.0.0.1:${remotePort}`, token: "y", defaultProject: "Other" },
      ],
      {
        ...DEFAULTS,
        port: 0,
        token: "bridge",
        tailscale: false,
        host: null,
        name: "test",
        t3Token: "x",
      },
    );
  });

  after(async () => {
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });

  it("merges hosts and prefixes remote titles", async () => {
    const rows = await provider.listSessions(10);
    assert.deepEqual(
      rows.map((r) => ({ id: r.id, title: r.title })),
      [
        { id: "studio:remote-thread", title: "studio · Review" },
        { id: "local-thread", title: "HUD" },
      ],
    );
  });
});
