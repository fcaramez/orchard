use std::process::Command;

/// GUI apps on macOS start with a minimal PATH, so tools installed via
/// Homebrew, nvm, cargo, etc. are invisible. Copy the login shell's PATH.
pub fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(output) = Command::new(&shell)
        .args(["-l", "-i", "-c", "printf '__ORCHARD__%s__ORCHARD__' \"$PATH\""])
        .output()
    else {
        return;
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(path) = stdout.split("__ORCHARD__").nth(1).filter(|p| !p.is_empty()) {
        // SAFETY: called once at startup, before any other thread exists.
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[tauri::command]
pub async fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    Command::new(editor.trim())
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs are allowed".into());
    }
    Command::new("open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// First positional CLI argument as an absolute path, so `orchard .` from a
/// terminal opens that worktree.
#[tauri::command]
pub fn startup_path() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    std::fs::canonicalize(arg).ok().map(|p| p.to_string_lossy().into_owned())
}
