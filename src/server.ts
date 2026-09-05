import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { addClient, getMessages, sessionHasClients } from "./sse.ts";
import type { T3Provider } from "./provider.ts";
import { parseWireProvider, WIRE_PROVIDER, type ProviderDecision } from "./types.ts";

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function statusOf(err: unknown): number {
  const n = (err as { statusCode?: number }).statusCode;
  return typeof n === "number" ? n : 500;
}

function checkAuth(url: URL, req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ")
    ? header.slice(7)
    : url.searchParams.get("token");
  return provided === token;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  provider: T3Provider,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,Last-Event-ID",
    });
    res.end();
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, { ok: true, provider: parseWireProvider(url.searchParams.get("provider")) });
    return;
  }

  if (pathname === "/" || pathname === "/favicon.ico") {
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("even-t3-bridge\nEven App → Settings → Terminal Mode → Add Host\n");
    return;
  }

  if (!pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!checkAuth(url, req, token)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing 'sessionId' query parameter" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(":ok\n\n");
    const lastRaw = req.headers["last-event-id"];
    const lastEventId = lastRaw ? parseInt(String(lastRaw), 10) : 0;
    const remove = addClient(sessionId, res, {
      needReplay: url.searchParams.get("needReplay") === "true",
      lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        remove();
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      remove();
    });
    return;
  }

  const body = req.method === "POST" ? await readBody(req) : {};

  if (pathname === "/api/sessions" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 10;
    const wire = parseWireProvider(url.searchParams.get("provider"));
    const sessions = await provider.listSessions(limit, wire);
    sendJson(res, 200, { sessions });
    return;
  }

  if (pathname === "/api/info" && req.method === "GET") {
    sendJson(res, 200, await provider.getInfo(parseWireProvider(url.searchParams.get("provider"))));
    return;
  }

  if (pathname === "/api/update-check" && req.method === "GET") {
    sendJson(res, 200, {
      packageName: "even-t3-bridge",
      currentVersion: "0.1.0",
      newestVersion: null,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/prompt" && req.method === "POST") {
    const text = body.text;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    console.log(`[prompt] session=${sessionId ?? "(new)"} text=${JSON.stringify(String(text ?? "").slice(0, 80))}`);
    if (!text || typeof text !== "string") {
      sendJson(res, 400, { error: "Missing 'text' field" });
      return;
    }
    try {
      const result = await provider.prompt(sessionId, text);
      sendJson(res, 202, { ok: true, sessionId: result.sessionId, provider: result.provider });
    } catch (err) {
      sendJson(res, statusOf(err), { error: (err as Error).message });
    }
    return;
  }

  if (pathname === "/api/permission-response" && req.method === "POST") {
    const sessionId = body.sessionId;
    const decision = (body.decision as ProviderDecision | undefined) ?? "deny";
    console.log(`[permission-response] session=${sessionId ?? "(none)"} decision=${decision}`);
    if (typeof sessionId !== "string") {
      sendJson(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    try {
      await provider.respondPermission(sessionId, decision);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, statusOf(err), { error: (err as Error).message });
    }
    return;
  }

  if (pathname === "/api/question-response" && req.method === "POST") {
    const sessionId = body.sessionId;
    const answer = typeof body.answer === "string" ? body.answer : "skip";
    if (typeof sessionId !== "string") {
      sendJson(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    try {
      await provider.respondQuestion(sessionId, answer);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, statusOf(err), { error: (err as Error).message });
    }
    return;
  }

  if (pathname === "/api/interrupt" && req.method === "POST") {
    const sessionId = body.sessionId;
    if (typeof sessionId !== "string") {
      sendJson(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    if (!provider.getStatus(sessionId)) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    provider.interrupt(sessionId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const status = provider.getStatus(sessionId);
    if (!status) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, { state: status.state, sessionId, provider: status.provider });
    return;
  }

  if (pathname === "/api/messages" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing 'sessionId'" });
      return;
    }
    const after = parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
    const status = provider.getStatus(sessionId);
    sendJson(res, 200, {
      messages: getMessages(sessionId, after),
      state: status?.state ?? "idle",
      sessionId,
      provider: status?.provider ?? WIRE_PROVIDER,
      live: sessionHasClients(sessionId),
    });
    return;
  }

  const hist = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (hist && req.method === "GET") {
    const id = decodeURIComponent(hist[1]!);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 10);
    sendJson(res, 200, { history: await provider.getHistory(id, limit) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function startHttpServer(
  provider: T3Provider,
  opts: { port: number; host?: string; token: string; log?: boolean },
): Promise<StartedServer> {
  const log = opts.log ?? true;
  const server: Server = createServer((req, res) => {
    const startedAt = Date.now();
    if (log) {
      const ip = req.socket.remoteAddress?.replace("::ffff:", "") ?? "?";
      res.on("finish", () => {
        const url = (req.url ?? "").replace(/token=[^&]*/g, "token=***");
        console.log(`[${ip}] ${res.statusCode} ${req.method} ${url} ${Date.now() - startedAt}ms`);
      });
    }
    handle(req, res, provider, opts.token).catch((err) => {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
