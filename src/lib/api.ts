import { Channel, invoke } from "@tauri-apps/api/core";
import type { Branches, Config, PtyEvent, PullRequest, Worktree } from "./types";

export const api = {
  configLoad: () => invoke<Config>("config_load"),
  configSave: (config: Config) => invoke<void>("config_save", { config }),

  resolveRepo: (path: string) => invoke<string>("git_resolve_repo", { path }),
  listWorktrees: (repo: string) => invoke<Worktree[]>("git_list_worktrees", { repo }),
  listBranches: (repo: string) => invoke<Branches>("git_list_branches", { repo }),
  createWorktree: (args: { repo: string; branch: string; base: string | null; root: string | null }) =>
    invoke<string>("git_create_worktree", args),
  removeWorktree: (args: { repo: string; path: string; force: boolean; deleteBranch: string | null }) =>
    invoke<void>("git_remove_worktree", args),

  prStatus: (cwd: string, branch: string) => invoke<PullRequest | null>("gh_pr_status", { cwd, branch }),

  ptySpawn: (
    args: { id: string; cwd: string; command: string | null; cols: number; rows: number },
    onEvent: Channel<PtyEvent>,
  ) => invoke<void>("pty_spawn", { ...args, onEvent }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),

  openInEditor: (editor: string, path: string) => invoke<void>("open_in_editor", { editor, path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  startupPath: () => invoke<string | null>("startup_path"),
};

export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
