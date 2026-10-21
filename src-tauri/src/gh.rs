use crate::git::run;
use std::path::Path;

/// Returns the raw `gh pr view` JSON for the branch, or `None` when the
/// branch has no PR. The frontend summarises checks from it.
#[tauri::command]
pub async fn gh_pr_status(cwd: String, branch: String) -> Result<Option<serde_json::Value>, String> {
    let fields = "number,title,state,url,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";
    match run(Path::new(&cwd), "gh", &["pr", "view", &branch, "--json", fields]) {
        Ok(out) => serde_json::from_str(&out).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.contains("no pull requests found") => Ok(None),
        Err(e) => Err(e),
    }
}
