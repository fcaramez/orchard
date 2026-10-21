use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run(cwd, "git", args)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    branch: Option<String>,
    head: String,
    is_main: bool,
    locked: bool,
    prunable: bool,
    changes: usize,
}

fn parse_worktrees(porcelain: &str) -> Vec<Worktree> {
    porcelain
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .enumerate()
        .filter_map(|(index, block)| {
            let mut wt = Worktree {
                path: String::new(),
                branch: None,
                head: String::new(),
                is_main: index == 0,
                locked: false,
                prunable: false,
                changes: 0,
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => wt.path = value.to_owned(),
                    "HEAD" => wt.head = value.to_owned(),
                    "branch" => wt.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
                    "locked" => wt.locked = true,
                    "prunable" => wt.prunable = true,
                    _ => {}
                }
            }
            (!wt.path.is_empty()).then_some(wt)
        })
        .collect()
}

/// Resolves any path inside a repository (or one of its worktrees) to the
/// main worktree, so a repo is always registered by the same path.
#[tauri::command]
pub async fn git_resolve_repo(path: String) -> Result<String, String> {
    let porcelain = git(Path::new(&path), &["worktree", "list", "--porcelain"])?;
    parse_worktrees(&porcelain)
        .into_iter()
        .next()
        .map(|wt| wt.path)
        .ok_or_else(|| "not a git repository".into())
}

#[tauri::command]
pub async fn git_list_worktrees(repo: String) -> Result<Vec<Worktree>, String> {
    let porcelain = git(Path::new(&repo), &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_worktrees(&porcelain);
    for wt in worktrees.iter_mut().filter(|wt| !wt.prunable) {
        wt.changes = git(Path::new(&wt.path), &["status", "--porcelain"])
            .map(|out| out.lines().count())
            .unwrap_or(0);
    }
    Ok(worktrees)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    local: Vec<String>,
    remote: Vec<String>,
    default_branch: String,
}

#[tauri::command]
pub async fn git_list_branches(repo: String) -> Result<Branches, String> {
    let cwd = Path::new(&repo);
    let lines = |refs: &str| -> Result<Vec<String>, String> {
        Ok(git(cwd, &["for-each-ref", "--format=%(refname:short)", refs])?
            .lines()
            .filter(|l| !l.ends_with("/HEAD") && !l.is_empty())
            .map(str::to_owned)
            .collect())
    };
    let default_branch = git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .or_else(|_| git(cwd, &["branch", "--show-current"]))
        .unwrap_or_else(|_| "main".into());
    Ok(Branches { local: lines("refs/heads")?, remote: lines("refs/remotes")?, default_branch })
}

fn sanitize(branch: &str) -> String {
    branch.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect()
}

/// Default location: `<parent>/<repo>.worktrees/<branch>`, next to the repo.
fn default_worktree_path(repo: &Path, branch: &str) -> PathBuf {
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    repo.parent()
        .unwrap_or(repo)
        .join(format!("{name}.worktrees"))
        .join(sanitize(branch))
}

#[tauri::command]
pub async fn git_create_worktree(
    repo: String,
    branch: String,
    base: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let cwd = Path::new(&repo);
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch name is required".into());
    }
    git(cwd, &["check-ref-format", "--branch", branch])?;

    let path = match root.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(root) => {
            let name = cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            PathBuf::from(shellexpand_home(root)).join(name).join(sanitize(branch))
        }
        None => default_worktree_path(cwd, branch),
    };
    let path_str = path.to_string_lossy().into_owned();

    let exists = git(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        git(cwd, &["worktree", "add", &path_str, branch])?;
    } else {
        let base = base.unwrap_or_else(|| "HEAD".into());
        git(cwd, &["worktree", "add", "-b", branch, &path_str, &base])?;
    }
    Ok(path_str)
}

fn shellexpand_home(path: &str) -> String {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path.to_owned(),
    }
}

#[tauri::command]
pub async fn git_remove_worktree(
    repo: String,
    path: String,
    force: bool,
    delete_branch: Option<String>,
) -> Result<(), String> {
    let cwd = Path::new(&repo);
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    git(cwd, &args)?;
    if let Some(branch) = delete_branch {
        git(cwd, &["branch", "-D", &branch])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let input = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r.wt/feat\nHEAD def\nbranch refs/heads/feat/x\nlocked\n\nworktree /r.wt/d\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n";
        let wts = parse_worktrees(input);
        assert_eq!(wts.len(), 3);
        assert!(wts[0].is_main);
        assert_eq!(wts[1].branch.as_deref(), Some("feat/x"));
        assert!(wts[1].locked);
        assert_eq!(wts[2].branch, None);
        assert!(wts[2].prunable);
    }

    fn sh(cwd: &Path, args: &[&str]) {
        run(cwd, "git", args).unwrap();
    }

    #[test]
    fn create_list_and_remove_worktree() {
        let tmp = std::env::temp_dir().join(format!("orchard-test-{}", std::process::id()));
        let repo = tmp.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let repo_str = repo.to_string_lossy().into_owned();

        let path = tauri::async_runtime::block_on(git_create_worktree(repo_str.clone(), "feat/x".into(), Some("main".into()), None)).unwrap();
        assert!(path.ends_with("app.worktrees/feat-x"));
        std::fs::write(Path::new(&path).join("new.txt"), "hi").unwrap();

        let resolved = tauri::async_runtime::block_on(git_resolve_repo(path.clone())).unwrap();
        assert_eq!(std::fs::canonicalize(resolved).unwrap(), std::fs::canonicalize(&repo).unwrap());

        let wts = tauri::async_runtime::block_on(git_list_worktrees(repo_str.clone())).unwrap();
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(wts[1].changes, 1);

        // Existing branch is checked out instead of re-created.
        assert!(tauri::async_runtime::block_on(git_create_worktree(repo_str.clone(), "feat/x".into(), None, None)).is_err());

        assert!(tauri::async_runtime::block_on(git_remove_worktree(repo_str.clone(), path.clone(), false, None)).is_err());
        tauri::async_runtime::block_on(git_remove_worktree(repo_str.clone(), path, true, Some("feat/x".into()))).unwrap();
        let branches = tauri::async_runtime::block_on(git_list_branches(repo_str)).unwrap();
        assert_eq!(branches.local, vec!["main".to_string()]);
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn default_path_sits_next_to_repo() {
        let p = default_worktree_path(Path::new("/code/app"), "feat/login");
        assert_eq!(p, PathBuf::from("/code/app.worktrees/feat-login"));
    }
}
