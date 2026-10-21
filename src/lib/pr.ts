import type { CheckState, PrSummary, PullRequest } from "./types";

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function summarizePr(pr: PullRequest): PrSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of pr.statusCheckRollup ?? []) {
    if (check.__typename === "CheckRun") {
      if (check.status !== "COMPLETED") pending++;
      else if (PASSING.has(check.conclusion ?? "")) passed++;
      else failed++;
    } else if (check.state === "SUCCESS") passed++;
    else if (check.state === "PENDING" || check.state === "EXPECTED") pending++;
    else failed++;
  }
  const state: CheckState =
    failed > 0 ? "failure" : pending > 0 ? "pending" : passed > 0 ? "success" : "none";
  return { pr, checks: { state, passed, failed, pending } };
}
