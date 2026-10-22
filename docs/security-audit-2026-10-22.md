# Security and performance audit — 2026-10-22

Audited at `f29ec2c` (`feat/auto-update`). Every Rust/TS source, config, workflow and script was read in full; two independent review passes (security, performance) were run and each claim was verified against the code, `node_modules`, or the crate sources before being kept. `pnpm audit --prod` is clean. `cargo audit` results are at the end.

Line references are to `f29ec2c`.

## Security

### S1 · `Cargo.lock` does not contain the updater — **High**

`src-tauri/Cargo.lock` was last changed in `c2abb37` (v0.2.0); `tauri-plugin-updater` was added in `ac5f67d`. The lock has no entry for `tauri-plugin-updater` or `minisign-verify`, and `cargo metadata --locked` fails. Every CI and release build re-resolves the whole updater subtree (reqwest, minisign-verify, tar, flate2, … 45 crates) to whatever is newest on crates.io that day, with nothing in the repo to review. CI never notices: `cargo test` rewrites the lock, and the `git diff --exit-code` check at `ci.yml:52` only covers `src/lib/bindings`.

**Fix:** run plain `cargo metadata` (or any `cargo build`) in `src-tauri` and commit `Cargo.lock` — it adds only the missing subtree. Do not use `cargo generate-lockfile`; it re-resolves everything. Then add `--locked` to `cargo clippy`/`cargo test` in `ci.yml:49-50` and `pnpm tauri build -- --locked` in `release.yml:45,106`.

### S2 · Unsigned manifest allows rollback to any previously signed release — **High**

`latest.json` is a plain asset; the minisign signature covers only the archive. The plugin's default comparator is `release.version > current_version` and nothing else. A `latest.json` claiming `"version": "99.0.0"` that points at the old `v0.2.0` archive and its genuine signature passes verification, and every install with auto-update on (the default, `config.rs:57`) reinstalls the old build at each 6-hour check. Needs only write access to release assets — repo write, a leaked `GITHUB_TOKEN` (every `release.yml` job has `contents: write`), or a compromised action — not the signing key.

`tauri-plugin-updater` 2.14.0 (what resolves today) has `plugins.updater.require_signed_version`; its doc comment describes exactly this attack. It checks a `version:` field in the minisign trusted comment, which `@tauri-apps/cli` 2.12.3 already writes. It rejects releases signed before the CLI recorded the version — but there are none: v0.2.0 shipped without an updater.

**Fix:** set `"requireSignedVersion": true` under `plugins.updater` in `tauri.conf.json` before the first signed release.

### S3 · Linux in-app install: verified bytes → user-writable tmp → `pkexec dpkg -i` — **Medium**

`src-tauri/src/update.rs:65-81` verifies the signature on the in-memory `.deb`, then the plugin (`try_tmp_locations`) writes it to `std::env::temp_dir()/tauri_deb_update*/package.deb` — a 0700 dir, but owned by the user — and runs `pkexec dpkg -i <path>`. Between the write and dpkg opening the file sits the polkit password prompt. Any same-uid process can swap the file in that window, and in this app "same-uid process" is exactly the coding agents running in PTYs. A prompt-injected agent polls for the file, drops in a `.deb` with a root `postinst`, and the user types their password for what looks like Orchard's own update. If pkexec is absent the plugin falls back to a zenity password dialog piped to `sudo -S`.

**Fix (least code):** drop in-app install on Linux. `update_check` reports the version; the sidebar button opens the release page or shows `sudo apt install ./orchard_amd64.deb` (already in the README). Alternative: copy and re-verify inside the privileged step (`pkexec sh -c 'd=$(mktemp -d) && cp "$1" "$d/p.deb" && echo "$2  $d/p.deb" | sha256sum -c && dpkg -i "$d/p.deb"' sh <path> <sha256>`).

### S4 · OSC 8 hyperlinks in terminal output bypass the URL allowlist — **Medium-Low**

`src/components/Terminal.tsx:71-83` sets no `linkHandler`. xterm 6's default for OSC 8 links (`@xterm/xterm/src/browser/OscLinkProvider.ts:114`) is `confirm()` then `window.open()` + `location.href = uri` — not `api.openUrl`, not the opener capability — so neither the https/localhost allowlist (`src/lib/api.ts:57`) nor `capabilities/default.json` applies. Any program an agent runs can print `\e]8;;file:///…\e\\click me\e]8;;\e\\` with arbitrary display text. SECURITY.md:13 ("can only open https links…") is false for this path.

**Fix:** `linkHandler: { activate: (_e, uri) => void api.openUrl(uri).catch(() => undefined) }` in the XTerm options.

### S5 · Release is published before assets exist; a failed build leaves an empty "latest" — **Medium (availability)**

`release.yml:20-21` creates the release non-draft first. GitHub's `releases/latest` pointer moves immediately, so during the build `…/latest/download/latest.json` 404s for every running client and the cask's `livecheck :github_latest` sees a version with no DMG. If the macOS or Linux job fails, the empty release stays "latest" and every install stops updating until a human intervenes.

**Fix:** `gh release create --draft`, and in `updater-manifest` after uploading `latest.json`: `gh release edit "$GITHUB_REF_NAME" --draft=false`.

### S6 · Signing key is in the environment of the whole `tauri build` step — **Medium (hardening)**

`release.yml:45-48,106-109`: `TAURI_SIGNING_PRIVATE_KEY` and its password are visible to `tsc`, every Vite plugin, and every crate's `build.rs`/proc-macro — on the macOS release target that is 54 build-script crates and 24 proc-macro crates, on a runner with open egress. Combined with S1, a malicious crate version is picked up automatically and can exfiltrate the key every auto-updating client trusts.

**Fix:** build without the secrets (`createUpdaterArtifacts` off), then `tar czf Orchard.app.tar.gz Orchard.app` and `pnpm tauri signer sign -k "$KEY" -p "$PW" <file>` as a separate step with only those two vars. Also: tag protection or a `release` environment with required reviewers (any tag push ships a signed update today); pin third-party actions to SHAs; scope `HOMEBREW_TAP_TOKEN` to a fine-grained PAT on the tap repo.

### Checked and fine

IPC capabilities (no `shell`, no `open-path`, opener scoped); CSP; all `git` args behind `--` with `check-ref-format` and path `sanitize()`; `gh` output typed via serde, PR URLs only via `api.openUrl`; `open_in_editor` uses `shell_words`, no shell; `startup_path` canonicalised; atomic config write + corrupt-file quarantine; bundled `tools/` appended last on PATH; `fetch-tools.sh` fails closed on a missing checksum line; macOS updater path crosses no privilege boundary; cask/README/site are honest about the ad-hoc signature and quarantine strip.

## Performance

### P1 · Window open blocks on an interactive login shell — **High (startup)**

`src-tauri/src/lib.rs:16` → `system.rs:19-50`: `adopt_login_shell_path()` runs `$SHELL -l -i -c 'printf $PATH'` and waits up to 2 s before `tauri::Builder` starts. With oh-my-zsh/nvm/pyenv that is 200 ms–1 s per launch. Then `git.rs:75-89` awaits `git status` for every worktree before the first `WorktreeView` can render (`App.tsx:248`).

**Fix:** run the PATH probe on a background thread into a `OnceLock`, read lazily in `process::run`/`pty::spawn`/`open_in_editor` (also removes the `unsafe set_var`). Return the worktree list without `changes` and fill counts from a second command.

### P2 · One webview eval or IPC round trip per PTY read, no coalescing — **High (while agents stream)**

`pty.rs:199-206` → `Output::push` (`:68`) sends every `read()` immediately; PTY masters return ~1–4 KB per read regardless of the 16 KB buffer. In `tauri/src/ipc/channel.rs`, a raw chunk under 1024 bytes is serialised as a JSON byte array (`new Uint8Array([104,101,…])`) inside a `webview.eval` — ~4× expansion and a per-byte JS parse; 1024+ bytes go into a global `Mutex<HashMap>` queue and the webview does a `fetch` round trip. PTY reads straddle that threshold, so a streaming agent alternates between both worst cases, for every attached session including hidden tabs.

**Fix:** coalesce in the reader thread — poll the fd for ~4 ms / up to 64 KB before pushing. Hundreds of evals become a handful of fetches.

### P3 · xterm is on the DOM renderer — **Medium-High**

`Terminal.tsx:71-84` loads fit + web-links only, so xterm 6 uses `DomRenderer`, which rebuilds row spans per refresh. Claude Code and lazygit are full-screen TUIs redrawing 10–30 fps; this is the dominant webview CPU while an agent streams.

**Fix:** `@xterm/addon-webgl` in a try/catch with `onContextLoss → dispose` so WebKitGTK without WebGL2 falls back.

### P4 · lazygit spawned eagerly for every open worktree, even hidden ones — **Medium**

`WorktreeView.tsx:213-220` mounts the lazygit terminal unconditionally (`display:none` when toggled off, still attached → spawned), and `App.tsx:245-267` mounts every open worktree. Per open worktree: two login shells + agent + lazygit, and lazygit runs its own git refresh loop and redraws into a pane nobody sees (output that crosses IPC per P2).

**Fix:** mount the lazygit `Terminal` the first time the view is active with the pane shown; sessions outlive views so nothing else changes.

### P5 · Focus re-poll has no throttle and no overlap guard — **Medium**

`usePolling.ts:16-17` fires on both `focus` and `visibilitychange` (un-minimising hits both): every ⌘-Tab in = R×`git worktree list` + W×`git status` + R×`gh pr list`. `useWorktrees.ts:26` + `git.rs:10` allow R×8 concurrent `git status`. A `git status` slower than 15 s or `gh` slower than 60 s stacks; `process.rs::run` has no timeout.

**Fix:** `inflight`/`lastRun` refs in `usePolling` (skip if in flight or < 3 s ago); `tokio::time::timeout(30s, …)` in `run`; run repos sequentially in `refreshAll`.

### P6 · Linux holds the whole update archive in memory until install — **Medium (Linux)**

`update.rs:46,56`: tens of MB in `pending` for hours or days. Moot if S3 drops the Linux installer; otherwise write to `app_cache_dir()` and delay the first check ~30 s (`useUpdate.ts:18-19` starts the download at launch, competing with the first git/gh calls).

### P7 · Splitter drag → PTY resize storm — **Low**

`WorktreeView.tsx:96-99` sets `split` per mousemove → ResizeObserver → `fit()` → `pty_resize` → SIGWINCH → full redraw of agent and lazygit every ~7 px. Debounce the observer (~50 ms) or commit on mouseup.

### P8 · Sidebar re-renders at 1 Hz forever — **Low**

`Sidebar.tsx:53-58` ticks `setNow` every second with or without activity. Only tick while some `activity[path]` is inside the 3 s busy window.

### P9 · CI/release build cost — **Low**

`ci.yml:10` runs tsc/eslint/vitest on `macos-latest`; `ubuntu-latest` is faster and ~10× cheaper. `Cargo.toml:39-43` fat LTO + `codegen-units = 1` on a universal target is two full fat-LTO compiles for an I/O-bound binary; `lto = "thin"` would do.

### Bug · language change reloads config and can race the save — **Low**

`useConfig.ts:36` depends on `t`; react-i18next rebinds `t` on `languageChanged`, so saving a language re-runs `configLoad` concurrently with the queued `configSave`. If the load reads the file before the rename lands, `current.current` reverts and the next `updateConfig` re-saves the stale config. Read `t` through a ref and drop it from the deps.

### Checked and fine

Raw `ArrayBuffer` output (no JSON escaping on the JS side), xterm's 12 ms write-buffer batching, hidden terminals don't render (IntersectionObserver), keystroke path is one sync IPC → mpsc → writer thread, `GIT_OPTIONAL_LOCKS=0`, one `gh pr list` per repo (~120 GraphQL points/h vs the 5000 limit), polling stops when hidden, release profile (lto/strip/panic=abort), ~1 MB bundle loaded from disk.

## `cargo audit`

Run against the dependency set a release build resolves today (the committed lock cannot be audited for the updater, see S1).

- **3 vulnerabilities, all in `zip` 4.6.1** (RUSTSEC-2026-0367/0368/0369: SUID preservation and symlink escape during extraction; patched ≥ 9.0). Pulled only by the updater's Windows NSIS/MSI path (`cfg(target_os = "windows")`); absent from the macOS and Linux graphs, so not compiled into Orchard. If `cargo audit` is added to CI it must `--ignore` these three or wait for the plugin to bump `zip`.
- Warnings, informational: `proc-macro-error` unmaintained; `zbus_names`/`zvariant`/`zvariant_derive` unmaintained (Linux, via the dialog/opener plugins); `glib` 0.18 unsoundness advisory.

## Suggested order

1. S1 — regenerate and commit `Cargo.lock`, `--locked` in CI. Ten minutes; unblocks trusting anything else about the updater.
2. S2 (`requireSignedVersion: true`), S5 (draft release → publish last), S4 (one-line `linkHandler`).
3. S3 — decide whether Linux in-app install is worth keeping; dropping it also closes P6.
4. P1, P2, P3 — the three users will actually feel.
5. S6 — update trust-chain hardening, once the plugin version is pinned.
