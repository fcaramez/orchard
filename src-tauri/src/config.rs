use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub repos: Vec<String>,
    /// Worktree paths shown at the top of the sidebar, in pin order.
    pub pinned: Vec<String>,
    pub agent_command: String,
    pub lazygit_command: String,
    pub editor_command: String,
    /// Optional root for new worktrees; empty means next to the repo.
    pub worktree_root: String,
    pub language: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            repos: Vec::new(),
            pinned: Vec::new(),
            agent_command: "claude".into(),
            lazygit_command: "lazygit".into(),
            editor_command: "code".into(),
            worktree_root: String::new(),
            language: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<Config, String> {
    let path = config_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        Err(_) => Ok(Config::default()),
    }
}

#[tauri::command]
pub fn config_save(app: AppHandle, config: Config) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(&app)?, raw).map_err(|e| e.to_string())
}
