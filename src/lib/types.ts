export interface Config {
  repos: string[];
  pinned: string[];
  agentCommand: string;
  lazygitCommand: string;
  editorCommand: string;
  worktreeRoot: string;
  language: string | null;
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  changes: number;
}

export interface Branches {
  local: string[];
  remote: string[];
  defaultBranch: string;
}

export type PtyEvent =
  | { kind: "data"; data: string }
  | { kind: "exit"; data: number | null };

interface CheckRun {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
}

interface StatusContext {
  __typename: "StatusContext";
  context: string;
  state: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: string;
  statusCheckRollup: (CheckRun | StatusContext)[] | null;
}

export type CheckState = "success" | "failure" | "pending" | "none";

export interface PrSummary {
  pr: PullRequest;
  checks: { state: CheckState; passed: number; failed: number; pending: number };
}
