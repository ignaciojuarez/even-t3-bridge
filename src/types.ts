export const WIRE_PROVIDER = "codex";
export const WIRE_PROVIDERS = ["claude", "codex"] as const;
export type WireProvider = (typeof WIRE_PROVIDERS)[number];

export function parseWireProvider(value: string | null | undefined): WireProvider {
  return value === "codex" || value === "claude" ? value : WIRE_PROVIDER;
}

export type SessionState =
  | "busy"
  | "idle"
  | "awaiting"
  | "think_start"
  | "think_end"
  | "text_start"
  | "text_end";

export type ProviderDecision = "allow" | "allowAlways" | "deny";

export type EvenMessage =
  | { type: "status"; state: SessionState; sessionId?: string }
  | { type: "text_delta"; text: string }
  | {
      type: "permission_request";
      toolName: string;
      description: string;
      detail: string;
      toolUseId: string;
      options: Array<{ text: string; key: string }>;
    }
  | {
      type: "permission_result";
      toolName: string;
      summary: string;
      decision: "allowed" | "always" | "denied";
    }
  | {
      type: "user_question";
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string; preview: string }>;
      }>;
      toolUseId: string;
    }
  | { type: "question_answer"; answers: Record<string, unknown> }
  | { type: "user_prompt"; text: string }
  | {
      type: "result";
      success: boolean;
      text: string;
      sessionId: string;
      costUsd: number;
      provider: string;
      turns: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "error"; message: string };

export type Emit = (sessionId: string, msg: EvenMessage) => void;

export interface SessionSummary {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  provider: string;
  status: SessionState | null;
}

export interface HistoryItem {
  role: string;
  text: string;
}

export interface PromptResult {
  sessionId: string;
  provider: string;
}

export interface StatusResult {
  state: SessionState;
  provider: string;
}

export interface T3ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface T3ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection?: T3ModelSelection | null;
  defaultThreadEnvMode?: string | null;
  defaultRuntimeMode?: string | null;
}

export interface T3Session {
  threadId?: string;
  status?: string | null;
  providerName?: string | null;
  activeTurnId?: string | null;
}

export interface T3LatestTurn {
  turnId?: string;
  state?: string | null;
}

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: T3ModelSelection | null;
  runtimeMode?: string;
  interactionMode?: string;
  branch?: string | null;
  worktreePath?: string | null;
  latestTurn?: T3LatestTurn | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  settledAt?: string | null;
  session?: T3Session | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}

export interface T3Message {
  id?: string;
  role: string;
  text: string;
  streaming?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface T3Activity {
  id?: string;
  kind: string;
  tone?: string;
  summary?: string;
  payload?: unknown;
  createdAt?: string;
}

export interface T3ThreadDetail {
  id: string;
  projectId: string;
  title: string;
  messages?: T3Message[];
  activities?: T3Activity[];
  session?: T3Session | null;
  latestTurn?: T3LatestTurn | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}

export interface T3ShellSnapshot {
  snapshotSequence?: number;
  projects: T3ProjectShell[];
  threads: T3ThreadShell[];
  updatedAt?: string;
}

export interface T3Question {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string; preview?: string }>;
}

export interface PendingRequest {
  requestId: string;
  kind: "approval" | "user-input";
  createdAt: string;
  detail: string;
  summary: string;
  questions?: T3Question[];
}
