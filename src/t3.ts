import { randomUUID } from "node:crypto";
import type {
  T3ModelSelection,
  T3ShellSnapshot,
  T3ThreadDetail,
} from "./types.ts";

export class T3Client {
  constructor(
    readonly origin: string,
    readonly token: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw Object.assign(new Error(`T3 ${path} HTTP ${res.status}: ${raw.slice(0, 800)}`), {
          status: res.status,
        });
      }
      return (raw ? JSON.parse(raw) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getShell(): Promise<T3ShellSnapshot> {
    const data = await this.request<T3ShellSnapshot>("GET", "/api/orchestration/shell");
    return {
      snapshotSequence: data.snapshotSequence,
      projects: data.projects ?? [],
      threads: data.threads ?? [],
      updatedAt: data.updatedAt,
    };
  }

  async getThread(threadId: string, turnLimit = 24): Promise<T3ThreadDetail> {
    const qs = new URLSearchParams({ turnLimit: String(turnLimit) });
    const data = await this.request<{ thread?: T3ThreadDetail } | T3ThreadDetail>(
      "GET",
      `/api/orchestration/threads/${encodeURIComponent(threadId)}?${qs}`,
    );
    if (data && typeof data === "object" && "thread" in data && data.thread) {
      return data.thread;
    }
    return data as T3ThreadDetail;
  }

  async dispatch(command: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    return this.request("POST", "/api/orchestration/dispatch", command, timeoutMs);
  }

  now(): string {
    return new Date().toISOString();
  }

  async createThread(input: {
    threadId: string;
    projectId: string;
    title: string;
    modelSelection: T3ModelSelection;
    runtimeMode: string;
    interactionMode: string;
    worktreePath?: string | null;
    branch?: string | null;
  }): Promise<void> {
    await this.dispatch({
      type: "thread.create",
      commandId: randomUUID(),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title.slice(0, 80) || "Glasses",
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.branch ?? null,
      worktreePath: input.worktreePath ?? null,
      createdAt: this.now(),
    });
  }

  async startTurn(input: {
    threadId: string;
    text: string;
    modelSelection: T3ModelSelection;
    runtimeMode: string;
    interactionMode: string;
  }): Promise<void> {
    await this.dispatch(
      {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId: input.threadId,
        message: {
          messageId: randomUUID(),
          role: "user",
          text: input.text.slice(0, 100_000),
          attachments: [],
        },
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: this.now(),
      },
      120_000,
    );
  }

  async respondApproval(threadId: string, requestId: string, decision: string): Promise<void> {
    await this.dispatch({
      type: "thread.approval.respond",
      commandId: randomUUID(),
      threadId,
      requestId,
      decision,
      createdAt: this.now(),
    });
  }

  async respondUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    await this.dispatch({
      type: "thread.user-input.respond",
      commandId: randomUUID(),
      threadId,
      requestId,
      answers,
      createdAt: this.now(),
    });
  }

  async interrupt(threadId: string): Promise<void> {
    await this.dispatch({
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId,
      createdAt: this.now(),
    });
  }
}
