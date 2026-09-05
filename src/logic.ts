import type {
  Emit,
  PendingRequest,
  SessionState,
  T3Activity,
  T3ProjectShell,
  T3ThreadShell,
} from "./types.ts";
import { WIRE_PROVIDER } from "./types.ts";

export function sessionStateFromThread(thread: T3ThreadShell): SessionState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "awaiting";
  const status = thread.session?.status;
  if (status === "starting" || status === "running") return "busy";
  if (thread.latestTurn?.state === "running") return "busy";
  return "idle";
}

export function turnFailed(thread: T3ThreadShell): boolean {
  const status = thread.session?.status;
  return status === "error" || status === "interrupted" || thread.latestTurn?.state === "error";
}

export function toSessionSummary(
  thread: T3ThreadShell,
  projects: T3ProjectShell[],
  provider: string = WIRE_PROVIDER,
): {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: string;
  status: SessionState;
} {
  const project = projects.find((p) => p.id === thread.projectId);
  return {
    id: thread.id,
    title: thread.title || "Untitled",
    timestamp: thread.latestUserMessageAt || thread.updatedAt || thread.createdAt || "",
    cwd: thread.worktreePath || project?.workspaceRoot || "",
    provider,
    status: sessionStateFromThread(thread),
  };
}

export function listActiveThreads(threads: T3ThreadShell[]): T3ThreadShell[] {
  return threads
    .filter((t) => !t.archivedAt)
    .sort((a, b) => {
      const at = a.latestUserMessageAt || a.updatedAt || a.createdAt || "";
      const bt = b.latestUserMessageAt || b.updatedAt || b.createdAt || "";
      return bt.localeCompare(at);
    });
}

export interface NewPrompt {
  create: boolean;
  envHint: string | null;
  projectHint: string | null;
  text: string;
}

export const LOCAL_ENV = "local";

export function encodeSessionId(envId: string, threadId: string): string {
  return !envId || envId === LOCAL_ENV ? threadId : `${envId}:${threadId}`;
}

export function decodeSessionId(
  sessionId: string,
  envIds: string[] = [],
): { envId: string; threadId: string } {
  if (sessionId.startsWith(`${LOCAL_ENV}:`)) {
    return { envId: LOCAL_ENV, threadId: sessionId.slice(LOCAL_ENV.length + 1) };
  }
  const remote = envIds
    .filter((id) => id && id !== LOCAL_ENV)
    .sort((a, b) => b.length - a.length);
  for (const id of remote) {
    const prefix = `${id}:`;
    if (sessionId.startsWith(prefix)) {
      return { envId: id, threadId: sessionId.slice(prefix.length) };
    }
  }
  return { envId: LOCAL_ENV, threadId: sessionId };
}

function takeNamed(rest: string, names: string[]): { match: string | null; rest: string } {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const lower = rest.toLowerCase();
  for (const name of sorted) {
    if (!name || !lower.startsWith(name.toLowerCase())) continue;
    const next = rest[name.length];
    if (next && !/[\s:]/.test(next)) continue;
    return { match: name, rest: rest.slice(name.length).replace(/^[:\s-]+/, "").trim() };
  }
  return { match: null, rest };
}

const NEW_IN = /^\s*new(?:\s+thread)?\s+in\s+/i;
const NEW_ONLY = /^\s*new(?:\s+thread)?(?:[:\s-]+(.*))?$/i;

export function parseNewPrompt(
  text: string,
  sessionId?: string,
  aliasNames: string[] = [],
  envNames: string[] = [],
): NewPrompt {
  const trimmed = text.trim();
  if (NEW_IN.test(trimmed)) {
    let rest = trimmed.replace(NEW_IN, "").trim();
    const env = takeNamed(rest, envNames);
    if (env.match) rest = env.rest;
    const project = takeNamed(rest, aliasNames);
    if (project.match) {
      return { create: true, envHint: env.match, projectHint: project.match, text: project.rest };
    }
    if (!rest) {
      return { create: true, envHint: env.match, projectHint: null, text: "" };
    }
    const space = rest.search(/[:\s]/);
    if (space === -1) {
      return { create: true, envHint: env.match, projectHint: rest || null, text: "" };
    }
    return {
      create: true,
      envHint: env.match,
      projectHint: rest.slice(0, space).trim() || null,
      text: rest.slice(space).replace(/^[:\s-]+/, "").trim(),
    };
  }
  if (!sessionId && NEW_ONLY.test(trimmed)) {
    const match = trimmed.match(NEW_ONLY);
    const body = (match?.[1] ?? "").trim();
    if (body.length === 0 || /^(thread)?$/i.test(body)) {
      return { create: true, envHint: null, projectHint: null, text: "" };
    }
  }
  return { create: !sessionId, envHint: null, projectHint: null, text: trimmed };
}

export function projectNames(projects: T3ProjectShell[]): string[] {
  return projects.flatMap((p) => {
    const dashed = p.title.replace(/\s+/g, "-");
    return dashed === p.title ? [p.title] : [p.title, dashed];
  });
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function resolveProject(
  hint: string | null,
  projects: T3ProjectShell[],
  defaultTitle: string,
): T3ProjectShell {
  const find = (name: string) =>
    projects.find((p) => norm(p.title) === norm(name)) ?? projects.find((p) => p.id === name.trim());
  if (hint) {
    const match = find(hint);
    if (!match) throw new Error(`T3 project not found for "${hint}"`);
    return match;
  }
  if (defaultTitle) {
    const match = find(defaultTitle);
    if (!match) throw new Error(`T3 project not found for "${defaultTitle}"`);
    return match;
  }
  if (!projects[0]) throw new Error("No T3 projects available");
  return projects[0];
}

export function latestAssistantText(messages: Array<{ role: string; text: string }> | undefined): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "assistant" && messages[i]!.text) return messages[i]!.text;
  }
  return "";
}

export function deltaSince(previous: string, next: string): string {
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

export function isRewrite(previous: string, next: string): boolean {
  return !!previous && !!next && !next.startsWith(previous);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function derivePendingRequests(activities: T3Activity[] | undefined): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  for (const activity of activities ?? []) {
    const payload = asRecord(activity.payload);
    const requestId = typeof payload?.requestId === "string" && payload.requestId ? payload.requestId : null;
    if (!requestId) continue;
    const detail =
      (typeof payload?.detail === "string" && payload.detail) ||
      activity.summary ||
      requestId;
    if (activity.kind === "approval.requested") {
      open.set(requestId, {
        requestId,
        kind: "approval",
        createdAt: activity.createdAt ?? "",
        detail,
        summary: activity.summary ?? "Approval requested",
      });
    } else if (activity.kind === "user-input.requested") {
      open.set(requestId, {
        requestId,
        kind: "user-input",
        createdAt: activity.createdAt ?? "",
        detail,
        summary: activity.summary ?? "Input requested",
        questions: parseQuestions(payload),
      });
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      typeof payload?.detail === "string" &&
      /stale|unknown|no longer pending|not found/.test(payload.detail)
    ) {
      open.delete(requestId);
    }
  }
  return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function parseQuestions(payload: Record<string, unknown> | null): PendingRequest["questions"] {
  const raw = payload?.questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const id = typeof row.id === "string" ? row.id : "";
    const question = typeof row.question === "string" ? row.question : "";
    if (!id || !question) return [];
    const options = Array.isArray(row.options)
      ? row.options.flatMap((opt) => {
          const o = asRecord(opt);
          if (!o) return [];
          const label = typeof o.label === "string" ? o.label : "";
          if (!label) return [];
          return [
            {
              label,
              description: typeof o.description === "string" ? o.description : "",
              preview: typeof o.preview === "string" ? o.preview : "",
            },
          ];
        })
      : undefined;
    return [
      {
        id,
        question,
        header: typeof row.header === "string" ? row.header : undefined,
        options,
      },
    ];
  });
  return questions.length ? questions : undefined;
}

export function emitBusy(emit: Emit, sessionId: string): void {
  emit(sessionId, { type: "status", state: "busy", sessionId });
}

export function emitIdle(emit: Emit, sessionId: string): void {
  emit(sessionId, { type: "status", state: "idle", sessionId });
}

export function emitAwaiting(emit: Emit, sessionId: string): void {
  emit(sessionId, { type: "status", state: "awaiting", sessionId });
}

export function emitUserPrompt(emit: Emit, sessionId: string, text: string): void {
  emit(sessionId, { type: "user_prompt", text });
}

/** Firmware paint-and-persist sequence. sessionId is required on status frames. */
export function emitAssistantText(
  emit: Emit,
  sessionId: string,
  text: string,
  opts?: { success?: boolean },
): void {
  emit(sessionId, { type: "status", state: "text_start", sessionId });
  if (text) emit(sessionId, { type: "text_delta", text });
  emit(sessionId, { type: "status", state: "text_end", sessionId });
  emit(sessionId, {
    type: "result",
    success: opts?.success ?? true,
    text,
    sessionId,
    costUsd: 0,
    provider: WIRE_PROVIDER,
    turns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
}

export function emitTextDelta(emit: Emit, sessionId: string, started: boolean, chunk: string): boolean {
  if (!started) emit(sessionId, { type: "status", state: "text_start", sessionId });
  if (chunk) emit(sessionId, { type: "text_delta", text: chunk });
  return true;
}

export function emitTextEnd(emit: Emit, sessionId: string): void {
  emit(sessionId, { type: "status", state: "text_end", sessionId });
}

export function finishText(emit: Emit, sessionId: string, fullText: string, success = true): void {
  emitTextEnd(emit, sessionId);
  emit(sessionId, {
    type: "result",
    success,
    text: fullText,
    sessionId,
    costUsd: 0,
    provider: WIRE_PROVIDER,
    turns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
}

export function emitPermission(emit: Emit, sessionId: string, pending: PendingRequest): void {
  emit(sessionId, {
    type: "permission_request",
    toolName: pending.summary || "approval",
    description: pending.summary || "Approval requested",
    detail: pending.detail,
    toolUseId: pending.requestId,
    options: [
      { text: "Yes", key: "allow" },
      { text: "Yes, and always allow", key: "allowAlways" },
      { text: "No", key: "deny" },
    ],
  });
}

export function emitQuestion(emit: Emit, sessionId: string, pending: PendingRequest): void {
  const questions = pending.questions?.length
    ? pending.questions.map((q) => ({
        question: q.question,
        header: q.header || q.question,
        options: (q.options ?? []).map((o) => ({
          label: o.label,
          description: o.description ?? "",
          preview: o.preview ?? "",
        })),
      }))
    : [
        {
          question: pending.summary || "The agent needs input",
          header: pending.detail || pending.summary || "Input",
          options: [
            { label: "Yes", description: "", preview: "" },
            { label: "No", description: "", preview: "" },
          ],
        },
      ];
  emit(sessionId, { type: "user_question", toolUseId: pending.requestId, questions });
}

export function answersFromPending(pending: PendingRequest, answer: string): Record<string, unknown> {
  const answers: Record<string, unknown> = { answer };
  if (pending.questions?.length) {
    for (const q of pending.questions) answers[q.id] = answer;
  } else {
    answers[pending.requestId] = answer;
  }
  return answers;
}

export function mapDecision(
  decision: string | undefined,
): "accept" | "acceptForSession" | "decline" {
  if (decision === "allow" || decision === "accept") return "accept";
  if (decision === "allowAlways" || decision === "acceptAlways" || decision === "acceptForSession") {
    return "acceptForSession";
  }
  return "decline";
}

export function resultDecision(
  decision: string | undefined,
): "allowed" | "always" | "denied" {
  if (decision === "allowAlways" || decision === "acceptAlways" || decision === "acceptForSession") {
    return "always";
  }
  if (decision === "allow" || decision === "accept") return "allowed";
  return "denied";
}
