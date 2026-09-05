import type { ServerResponse } from "node:http";
import type { EvenMessage } from "./types.ts";

const MAX_MESSAGES = 500;

interface RingEntry {
  id: number;
  msg: EvenMessage;
}

interface SessionRing {
  messages: RingEntry[];
  clients: Set<ServerResponse>;
  nextId: number;
}

const sessions = new Map<string, SessionRing>();

function getSession(sessionId: string): SessionRing {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1 };
    sessions.set(sessionId, s);
  }
  return s;
}

export function pushMessage(sessionId: string, msg: EvenMessage): number {
  const s = getSession(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES) s.messages.shift();
  return id;
}

export function getMessages(
  sessionId: string,
  after: number,
): Array<{ id: number } & EvenMessage> {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return s.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
}

export function broadcast(sessionId: string, msg: EvenMessage, id: number): void {
  const s = sessions.get(sessionId);
  if (!s || s.clients.size === 0) return;
  const data = JSON.stringify(msg);
  for (const res of s.clients) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(res);
    }
  }
}

export function emit(sessionId: string, msg: EvenMessage): void {
  if (!sessionId) return;
  const id = pushMessage(sessionId, msg);
  broadcast(sessionId, msg, id);
}

export function sessionHasClients(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  return !!s && s.clients.size > 0;
}

export function addClient(
  sessionId: string,
  res: ServerResponse,
  opts: { needReplay?: boolean; lastEventId?: number },
): () => void {
  const s = getSession(sessionId);
  const replayFrom =
    opts.lastEventId && opts.lastEventId > 0
      ? opts.lastEventId
      : opts.needReplay
        ? 0
        : null;
  if (replayFrom !== null) {
    for (const entry of s.messages) {
      if (entry.id <= replayFrom) continue;
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }
  s.clients.add(res);
  return () => {
    s.clients.delete(res);
  };
}

export function resetSseForTests(): void {
  sessions.clear();
}
