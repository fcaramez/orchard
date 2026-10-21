import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewWorktreeDialog, RemoveWorktreeDialog, SettingsDialog } from "./components/Dialogs";
import { Sidebar } from "./components/Sidebar";
import { WorktreeView } from "./components/WorktreeView";
import { resolveLanguage } from "./i18n";
import { api } from "./lib/api";
import { summarizePr } from "./lib/pr";
import type { Config, PrSummary, Worktree } from "./lib/types";
import "./styles.css";

const WORKTREE_POLL_MS = 15_000;
const PR_POLL_MS = 60_000;

type DialogState =
  | { kind: "new"; repo: string }
  | { kind: "remove"; repo: string; worktree: Worktree }
  | { kind: "settings" }
  | null;

function withItem(set: Set<string>, item: string): Set<string> {
  return set.has(item) ? set : new Set(set).add(item);
}

function withoutItem(set: Set<string>, item: string): Set<string> {
  if (!set.has(item)) return set;
  const next = new Set(set);
  next.delete(item);
  return next;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Record<string, Worktree[]>>({});
  const [repoErrors, setRepoErrors] = useState<Record<string, string>>({});
  const [prs, setPrs] = useState<Record<string, PrSummary | null>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [attention, setAttention] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;
  // Last known worktree per open path, so a transient git error during a
  // refresh never unmounts a view (which would kill its agent).
  const knownWorktrees = useRef<Record<string, Worktree>>({});

  useEffect(() => {
    api
      .configLoad()
      .then((loaded) => {
        setConfig(loaded);
        void i18n.changeLanguage(resolveLanguage(loaded.language));
      })
      .catch((e: unknown) => setLoadError(String(e)));
  }, [i18n]);

  const saveConfig = useCallback(
    async (next: Config) => {
      setConfig(next);
      void i18n.changeLanguage(resolveLanguage(next.language));
      await api.configSave(next);
    },
    [i18n],
  );

  const repos = useMemo(() => config?.repos ?? [], [config]);

  const refreshRepo = useCallback(async (repo: string) => {
    try {
      const list = await api.listWorktrees(repo);
      setWorktrees((current) => ({ ...current, [repo]: list }));
      setRepoErrors((current) => withoutKey(current, repo));
    } catch (e) {
      setRepoErrors((current) => ({ ...current, [repo]: String(e) }));
    }
  }, []);

  const refreshAll = useCallback(() => Promise.all(repos.map(refreshRepo)), [repos, refreshRepo]);

  const refreshPrs = useCallback(async () => {
    const targets = Object.values(worktreesRef.current)
      .flat()
      .flatMap((wt) => (wt.branch && !wt.isMain ? [{ path: wt.path, branch: wt.branch }] : []));
    const results = await Promise.all(
      targets.map(async ({ path, branch }) => {
        try {
          const pr = await api.prStatus(path, branch);
          return [path, pr ? summarizePr(pr) : null] as const;
        } catch {
          return [path, null] as const;
        }
      }),
    );
    setPrs(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(), WORKTREE_POLL_MS);
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAll]);

  const worktreePathsKey = Object.values(worktrees)
    .flat()
    .map((wt) => `${wt.path}@${wt.branch ?? ""}`)
    .join("|");

  useEffect(() => {
    if (!worktreePathsKey) return;
    void refreshPrs();
    const timer = window.setInterval(() => void refreshPrs(), PR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [worktreePathsKey, refreshPrs]);

  const byPath = useMemo(() => {
    const map: Record<string, { repo: string; worktree: Worktree }> = {};
    for (const [repo, list] of Object.entries(worktrees)) {
      for (const worktree of list) map[worktree.path] = { repo, worktree };
    }
    return map;
  }, [worktrees]);

  const pinned = useMemo(() => config?.pinned ?? [], [config]);

  // Same order as the sidebar: pinned worktrees first, then repo by repo.
  const shortcutOrder = useMemo(() => {
    const rest = repos.flatMap((repo) => (worktrees[repo] ?? []).map((wt) => wt.path)).filter((p) => !pinned.includes(p));
    return [...pinned.filter((p) => p in byPath), ...rest].filter((p) => open.includes(p));
  }, [repos, worktrees, open, pinned, byPath]);

  const togglePin = useCallback(
    (path: string) => {
      if (!config) return;
      const next = config.pinned.includes(path)
        ? config.pinned.filter((p) => p !== path)
        : [...config.pinned, path];
      void saveConfig({ ...config, pinned: next });
    },
    [config, saveConfig],
  );

  const select = useCallback((path: string) => {
    setOpen((current) => (current.includes(path) ? current : [...current, path]));
    setSelected(path);
    setUnread((current) => withoutItem(current, path));
    setAttention((current) => withoutItem(current, path));
  }, []);

  const onActivity = useCallback((path: string) => {
    setActivity((current) => ({ ...current, [path]: Date.now() }));
    if (selectedRef.current !== path) setUnread((current) => withItem(current, path));
  }, []);

  const onBell = useCallback((path: string) => {
    if (selectedRef.current !== path || !document.hasFocus()) {
      setAttention((current) => withItem(current, path));
    }
  }, []);

  // `orchard <path>` opens the worktree containing <path>, registering its repo.
  const startupHandled = useRef(false);
  useEffect(() => {
    if (!config || startupHandled.current) return;
    startupHandled.current = true;
    void (async () => {
      const path = await api.startupPath();
      if (!path) return;
      try {
        const root = await api.resolveRepo(path);
        if (!config.repos.includes(root)) await saveConfig({ ...config, repos: [...config.repos, root] });
        const list = await api.listWorktrees(root);
        setWorktrees((current) => ({ ...current, [root]: list }));
        const match = list
          .filter((wt) => path === wt.path || path.startsWith(`${wt.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (match) select(match.path);
      } catch (e) {
        await message(String(e), { title: t("errors.notRepo"), kind: "error" });
      }
    })();
  }, [config, saveConfig, select, t]);

  const closeSessions = useCallback((path: string) => {
    setOpen((current) => current.filter((p) => p !== path));
    setSelected((current) => (current === path ? null : current));
    delete knownWorktrees.current[path];
  }, []);

  const requestRemove = useCallback(
    (worktree: Worktree) => {
      const repo = byPath[worktree.path]?.repo;
      if (repo) setDialog({ kind: "remove", repo, worktree });
    },
    [byPath],
  );

  const addRepo = async () => {
    if (!config) return;
    const picked = await openDialog({ directory: true, multiple: false, title: t("sidebar.addRepo") });
    if (typeof picked !== "string") return;
    try {
      const root = await api.resolveRepo(picked);
      if (!config.repos.includes(root)) await saveConfig({ ...config, repos: [...config.repos, root] });
      await refreshRepo(root);
    } catch (e) {
      await message(String(e), { title: t("errors.notRepo"), kind: "error" });
    }
  };

  const removeRepo = async (repo: string) => {
    if (!config) return;
    const confirmed = await ask(t("sidebar.removeRepoConfirm", { repo }), {
      title: t("sidebar.removeRepo"),
      kind: "warning",
    });
    if (!confirmed) return;
    const paths = (worktrees[repo] ?? []).map((wt) => wt.path);
    for (const path of paths) closeSessions(path);
    setWorktrees((current) => withoutKey(current, repo));
    await saveConfig({
      ...config,
      repos: config.repos.filter((r) => r !== repo),
      pinned: config.pinned.filter((p) => !paths.includes(p)),
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (/^[1-9]$/.test(event.key)) {
        const path = shortcutOrder[Number(event.key) - 1];
        if (path) {
          event.preventDefault();
          select(path);
        }
      } else if (event.key === "n" && !event.shiftKey) {
        const repo = (selected && byPath[selected]?.repo) || repos[0];
        if (repo) {
          event.preventDefault();
          setDialog({ kind: "new", repo });
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcutOrder, select, selected, byPath, repos]);

  if (loadError) return <div className="fatal">{loadError}</div>;
  if (!config) return <div className="fatal">{t("app.loading")}</div>;

  for (const path of open) {
    const entry = byPath[path];
    if (entry) knownWorktrees.current[path] = entry.worktree;
  }

  return (
    <div className="app">
      <Sidebar
        repos={repos}
        worktrees={worktrees}
        repoErrors={repoErrors}
        prs={prs}
        pinned={pinned}
        open={open}
        shortcutOrder={shortcutOrder}
        selected={selected}
        activity={activity}
        unread={unread}
        attention={attention}
        onSelect={select}
        onTogglePin={togglePin}
        onNewWorktree={(repo) => setDialog({ kind: "new", repo })}
        onAddRepo={() => void addRepo()}
        onRemoveRepo={(repo) => void removeRepo(repo)}
        onRefresh={() => void refreshAll().then(refreshPrs)}
        onSettings={() => setDialog({ kind: "settings" })}
      />

      <main className="main">
        {open.map((path) => {
          const worktree = knownWorktrees.current[path];
          if (!worktree) return null;
          return (
            <WorktreeView
              key={path}
              worktree={worktree}
              config={config}
              agentCommand={agentOverrides[path] ?? config.agentCommand}
              active={selected === path}
              pr={prs[path] ?? null}
              pinned={pinned.includes(path)}
              onTogglePin={togglePin}
              onActivity={onActivity}
              onBell={onBell}
              onRemove={requestRemove}
              onClose={closeSessions}
            />
          );
        })}

        {!selected && (
          <div className="empty" data-tauri-drag-region>
            {repos.length === 0 ? (
              <>
                <h1>{t("empty.welcomeTitle")}</h1>
                <p>{t("empty.welcomeBody")}</p>
                <button className="primary" onClick={() => void addRepo()}>
                  {t("sidebar.addRepo")}
                </button>
              </>
            ) : (
              <>
                <h1>{t("empty.pickTitle")}</h1>
                <p>{t("empty.pickBody")}</p>
              </>
            )}
          </div>
        )}
      </main>

      {dialog?.kind === "new" && (
        <NewWorktreeDialog
          repo={dialog.repo}
          config={config}
          onCancel={() => setDialog(null)}
          onCreated={async (path, agentCommand) => {
            const repo = dialog.repo;
            setDialog(null);
            setAgentOverrides((current) => ({ ...current, [path]: agentCommand }));
            await refreshRepo(repo);
            select(path);
          }}
        />
      )}

      {dialog?.kind === "remove" && (
        <RemoveWorktreeDialog
          worktree={dialog.worktree}
          onCancel={() => setDialog(null)}
          onConfirm={async ({ force, deleteBranch }) => {
            closeSessions(dialog.worktree.path);
            await api.removeWorktree({
              repo: dialog.repo,
              path: dialog.worktree.path,
              force,
              deleteBranch: deleteBranch ? dialog.worktree.branch : null,
            });
            setDialog(null);
            if (config.pinned.includes(dialog.worktree.path)) togglePin(dialog.worktree.path);
            await refreshRepo(dialog.repo);
          }}
        />
      )}

      {dialog?.kind === "settings" && (
        <SettingsDialog
          config={config}
          onCancel={() => setDialog(null)}
          onSave={(next) => {
            setDialog(null);
            void saveConfig(next);
          }}
        />
      )}
    </div>
  );
}
