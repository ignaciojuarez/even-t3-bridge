import { randomUUID } from "node:crypto";
import type { BridgeConfig, T3EnvSpec } from "./config.ts";
import {
  answersFromPending,
  decodeSessionId,
  deltaSince,
  derivePendingRequests,
  emitAssistantText,
  emitAwaiting,
  emitBusy,
  emitIdle,
  emitPermission,
  emitQuestion,
  emitTextDelta,
  emitTextEnd,
  emitUserPrompt,
  encodeSessionId,
  finishText,
  isRewrite,
  latestAssistantText,
  listActiveThreads,
  LOCAL_ENV,
  mapDecision,
  parseNewPrompt,
  projectNames,
  resolveProject,
  resultDecision,
  sessionStateFromThread,
  toSessionSummary,
  turnFailed,
} from "./logic.ts";
import { emit } from "./sse.ts";
import { T3Client } from "./t3.ts";
import type {
  HistoryItem,
  PendingRequest,
  PromptResult,
  ProviderDecision,
  SessionState,
  SessionSummary,
  StatusResult,
  T3ModelSelection,
  T3ShellSnapshot,
  T3ThreadShell,
} from "./types.ts";
import { WIRE_PROVIDER } from "./types.ts";

interface LiveTurn {
  streaming: boolean;
  painted: string;
  pendingId: string | null;
  pendingKind: "approval" | "user-input" | null;
  pending: PendingRequest | null;
  lastState: SessionState;
}

interface EnvRuntime {
  spec: T3EnvSpec;
  client: T3Client;
  shell: T3ShellSnapshot;
}

export class T3Provider {
  private envs = new Map<string, EnvRuntime>();
  private live = new Map<string, LiveTurn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    specs: T3EnvSpec[],
    readonly config: BridgeConfig,
  ) {
    if (!specs.length) throw new Error("no T3 environments");
    for (const spec of specs) {
      this.envs.set(spec.id, {
        spec,
        client: new T3Client(spec.origin, spec.token),
        shell: { projects: [], threads: [] },
      });
    }
  }

  /** Test helper: one local client, same as the old constructor. */
  static fromClient(client: T3Client, config: BridgeConfig): T3Provider {
    const provider = new T3Provider(
      [{ id: LOCAL_ENV, origin: client.origin, token: client.token, defaultProject: config.defaultProject }],
      config,
    );
    const env = provider.envs.get(LOCAL_ENV);
    if (env) env.client = client;
    return provider;
  }

  addEnvironment(spec: T3EnvSpec): boolean {
    if (this.envs.has(spec.id)) return false;
    this.envs.set(spec.id, {
      spec,
      client: new T3Client(spec.origin, spec.token),
      shell: { projects: [], threads: [] },
    });
    return true;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private envIds(): string[] {
    return [...this.envs.keys()];
  }

  private requireEnv(id: string): EnvRuntime {
    const env = this.envs.get(id);
    if (!env) throw Object.assign(new Error(`T3 environment "${id}" is not configured`), { statusCode: 404 });
    return env;
  }

  private split(sessionId: string): { env: EnvRuntime; threadId: string; wireId: string } {
    const { envId, threadId } = decodeSessionId(sessionId, this.envIds());
    const env = this.requireEnv(envId);
    return { env, threadId, wireId: encodeSessionId(env.spec.id, threadId) };
  }

  private liveOf(id: string): LiveTurn {
    let row = this.live.get(id);
    if (!row) {
      row = {
        streaming: false,
        painted: "",
        pendingId: null,
        pendingKind: null,
        pending: null,
        lastState: "idle",
      };
      this.live.set(id, row);
    }
    return row;
  }

  private async refreshShells(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.envs.values()].map(async (env) => {
        env.shell = await env.client.getShell();
      }),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const id = [...this.envs.keys()][i] ?? "?";
        console.error(`[t3 ${id}] shell: ${(result.reason as Error).message}`);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshShells();
      for (const env of this.envs.values()) {
        const ranked = listActiveThreads(env.shell.threads);
        const hot = ranked.filter((t) => sessionStateFromThread(t) !== "idle");
        const warming = ranked.filter((t) => {
          const wire = encodeSessionId(env.spec.id, t.id);
          return this.live.has(wire) && !hot.includes(t);
        });
        for (const thread of [...hot, ...warming].slice(0, 12)) {
          try {
            await this.syncThread(env, thread);
          } catch (err) {
            console.error(`[t3 ${env.spec.id}] sync ${thread.id}: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async syncThread(env: EnvRuntime, shellThread: T3ThreadShell): Promise<void> {
    const wireId = encodeSessionId(env.spec.id, shellThread.id);
    const pendingHint = !!(shellThread.hasPendingApprovals || shellThread.hasPendingUserInput);
    const detail = await env.client.getThread(shellThread.id, pendingHint ? 50 : 24);
    const merged = { ...shellThread, ...detail };
    const state = sessionStateFromThread(merged);
    const row = this.liveOf(wireId);
    const text = latestAssistantText(detail.messages);
    const streaming = detail.messages?.some((m) => m.role === "assistant" && m.streaming) ?? false;
    const pending = derivePendingRequests(detail.activities)[0] ?? null;
    const inTurn = state === "busy" || state === "awaiting";

    if (state === "busy" && row.lastState !== "busy") emitBusy(emit, wireId);

    if (text && text !== row.painted) {
      if (isRewrite(row.painted, text) && row.streaming) {
        emitTextEnd(emit, wireId);
        row.streaming = false;
        row.painted = "";
      }
      const chunk = deltaSince(row.painted, text);
      if (row.streaming || streaming || inTurn) {
        row.streaming = emitTextDelta(emit, wireId, row.streaming, chunk);
        row.painted = text;
      } else {
        emitAssistantText(emit, wireId, text, { success: !turnFailed(merged) });
        row.painted = text;
        row.streaming = false;
      }
    }

    if (row.streaming && !streaming && state === "awaiting") {
      emitTextEnd(emit, wireId);
      row.streaming = false;
    } else if (row.streaming && !streaming && state !== "busy") {
      finishText(emit, wireId, text || row.painted, !turnFailed(merged));
      row.streaming = false;
    }

    if (pending && pending.requestId !== row.pendingId) {
      emitAwaiting(emit, wireId);
      if (pending.kind === "approval") emitPermission(emit, wireId, pending);
      else emitQuestion(emit, wireId, pending);
      row.pendingId = pending.requestId;
      row.pendingKind = pending.kind;
      row.pending = pending;
    } else if (!pending) {
      row.pendingId = null;
      row.pendingKind = null;
      row.pending = null;
    }

    if (state === "idle" && row.lastState !== "idle") emitIdle(emit, wireId);
    row.lastState = state;
    if (state === "idle" && !pending) this.live.delete(wireId);
  }

  async listSessions(limit: number, provider: string = WIRE_PROVIDER): Promise<SessionSummary[]> {
    await this.refreshShells();
    const rows: SessionSummary[] = [];
    for (const env of this.envs.values()) {
      for (const thread of listActiveThreads(env.shell.threads)) {
        const summary = toSessionSummary(thread, env.shell.projects, provider);
        rows.push({
          ...summary,
          id: encodeSessionId(env.spec.id, thread.id),
          title: env.spec.id === LOCAL_ENV ? summary.title : `${env.spec.id} · ${summary.title}`,
        });
      }
    }
    return rows
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      .slice(0, limit);
  }

  async getSessionStatus(sessionId: string): Promise<SessionState> {
    return this.getStatus(sessionId)?.state ?? "idle";
  }

  getStatus(sessionId: string): StatusResult | null {
    const { env, threadId } = this.split(sessionId);
    const thread = env.shell.threads.find((t) => t.id === threadId);
    if (thread) return { state: sessionStateFromThread(thread), provider: WIRE_PROVIDER };
    if (this.live.has(sessionId)) {
      return { state: this.live.get(sessionId)!.lastState, provider: WIRE_PROVIDER };
    }
    return null;
  }

  async getInfo(provider: string = WIRE_PROVIDER): Promise<{
    account: Record<string, string>;
    model: string;
    version: string;
    provider: string;
  }> {
    return {
      account: { source: "t3", environments: this.envIds().join(",") },
      model: this.config.model?.model ?? "t3",
      version: "even-t3-bridge 0.1.0",
      provider,
    };
  }

  async getHistory(sessionId: string, limit: number): Promise<HistoryItem[]> {
    const { env, threadId } = this.split(sessionId);
    try {
      const detail = await env.client.getThread(threadId, Math.max(limit, 4));
      return (detail.messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-limit)
        .map((m) => ({ role: m.role, text: m.text }));
    } catch (err) {
      console.error(`[t3] history ${sessionId}: ${(err as Error).message}`);
      return [];
    }
  }

  async prompt(sessionId: string | undefined, text: string): Promise<PromptResult> {
    const envNames = this.envIds();
    const follow = sessionId ? this.split(sessionId) : null;
    const projectAliases = follow
      ? projectNames(follow.env.shell.projects)
      : [...this.envs.values()].flatMap((e) => projectNames(e.shell.projects));
    if (!projectAliases.length) {
      await this.refreshShells();
    }
    const aliases = follow
      ? projectNames(follow.env.shell.projects)
      : [...this.envs.values()].flatMap((e) => projectNames(e.shell.projects));
    const parsed = parseNewPrompt(text, sessionId, aliases, envNames);
    if (!parsed.text && parsed.create) {
      throw Object.assign(new Error("Say what you want the agent to do"), { statusCode: 400 });
    }
    const body = parsed.text || text;

    if (parsed.create || !sessionId || !follow) {
      const id = await this.createAndStart(parsed.envHint, parsed.projectHint, body);
      return { sessionId: id, provider: WIRE_PROVIDER };
    }

    const thread = follow.env.shell.threads.find((t) => t.id === follow.threadId);
    const model = thread?.modelSelection ?? this.requireModel();
    emitUserPrompt(emit, follow.wireId, body);
    emitBusy(emit, follow.wireId);
    this.liveOf(follow.wireId).lastState = "busy";
    await follow.env.client.startTurn({
      threadId: follow.threadId,
      text: body,
      modelSelection: model,
      runtimeMode: thread?.runtimeMode || this.config.runtimeMode || "ask",
      interactionMode: thread?.interactionMode ?? this.config.interactionMode,
    });
    return { sessionId: follow.wireId, provider: WIRE_PROVIDER };
  }

  private async createAndStart(
    envHint: string | null,
    projectHint: string | null,
    text: string,
  ): Promise<string> {
    const env = this.requireEnv(envHint ?? LOCAL_ENV);
    if (!env.shell.projects.length) env.shell = await env.client.getShell();
    let project;
    try {
      project = resolveProject(projectHint, env.shell.projects, env.spec.defaultProject || this.config.defaultProject);
    } catch (err) {
      throw Object.assign(err as Error, { statusCode: 404 });
    }
    const threadId = randomUUID();
    const wireId = encodeSessionId(env.spec.id, threadId);
    const model = this.config.model ?? project.defaultModelSelection ?? this.requireModel();
    const runtimeMode =
      this.config.runtimeMode ||
      project.defaultRuntimeMode ||
      project.defaultThreadEnvMode ||
      "ask";
    const title = text.slice(0, 60) || `Glasses ${project.title}`;
    await env.client.createThread({
      threadId,
      projectId: project.id,
      title,
      modelSelection: model,
      runtimeMode,
      interactionMode: this.config.interactionMode,
      worktreePath: null,
      branch: null,
    });
    emitUserPrompt(emit, wireId, text);
    emitBusy(emit, wireId);
    this.liveOf(wireId).lastState = "busy";
    await env.client.startTurn({
      threadId,
      text,
      modelSelection: model,
      runtimeMode,
      interactionMode: this.config.interactionMode,
    });
    return wireId;
  }

  private requireModel(): T3ModelSelection {
    if (this.config.model) return this.config.model;
    throw Object.assign(
      new Error("No model. Set model in ~/.even-t3-bridge/config.json or EVEN_T3_MODEL"),
      { statusCode: 400 },
    );
  }

  async respondPermission(sessionId: string, decision: ProviderDecision | string): Promise<void> {
    const { env, threadId, wireId } = this.split(sessionId);
    const requestId = await this.openRequestId(sessionId, "approval");
    if (!requestId) throw Object.assign(new Error("No pending approval"), { statusCode: 409 });
    const mapped = mapDecision(decision);
    await env.client.respondApproval(threadId, requestId, mapped);
    emit(wireId, {
      type: "permission_result",
      toolName: "approval",
      summary: mapped,
      decision: resultDecision(decision),
    });
  }

  async respondQuestion(sessionId: string, answer: string): Promise<void> {
    const { env, threadId, wireId } = this.split(sessionId);
    const pending = await this.openPending(sessionId, "user-input");
    if (!pending) throw Object.assign(new Error("No pending question"), { statusCode: 409 });
    const answers = answersFromPending(pending, answer);
    await env.client.respondUserInput(threadId, pending.requestId, answers);
    emit(wireId, { type: "question_answer", answers });
  }

  interrupt(sessionId: string): void {
    const { env, threadId } = this.split(sessionId);
    void env.client.interrupt(threadId).catch((err) => {
      console.error(`[t3] interrupt ${sessionId}: ${(err as Error).message}`);
    });
  }

  private async openRequestId(
    sessionId: string,
    kind: "approval" | "user-input",
  ): Promise<string | null> {
    const pending = await this.openPending(sessionId, kind);
    return pending?.requestId ?? null;
  }

  private async openPending(
    sessionId: string,
    kind: "approval" | "user-input",
  ): Promise<PendingRequest | null> {
    const row = this.live.get(sessionId);
    if (row?.pending && row.pendingKind === kind) return row.pending;
    try {
      const { env, threadId } = this.split(sessionId);
      const detail = await env.client.getThread(threadId, 50);
      return derivePendingRequests(detail.activities).find((p) => p.kind === kind) ?? null;
    } catch {
      return null;
    }
  }
}
