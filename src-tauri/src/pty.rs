use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    Data(String),
    Exit(Option<u32>),
}

struct Session {
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
    next_generation: AtomicU64,
}

impl PtyState {
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.kill();
        }
    }
}

/// Decodes as much valid UTF-8 as possible, keeping an incomplete trailing
/// sequence in `buf` so multi-byte characters split across reads survive.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let s = s.to_owned();
            buf.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            s
        }
    }
}

fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    match command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        // Run the command inside a login shell, then fall back to an
        // interactive shell so quitting the tool does not kill the pane.
        Some(c) => cmd.args(["-l", "-i", "-c", &format!("{c}; exec {shell} -l -i")]),
        None => cmd.args(["-l", "-i"]),
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "orchard");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(mut old) = sessions.insert(
            id.clone(),
            Session { generation, master: pair.master, writer, child },
        ) {
            let _ = old.child.kill();
        }
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && on_event.send(PtyEvent::Data(text)).is_err() {
                        break;
                    }
                }
            }
        }
        let state = app.state::<PtyState>();
        let finished = {
            let mut sessions = state.sessions.lock().unwrap();
            match sessions.get(&id) {
                Some(s) if s.generation == generation => sessions.remove(&id),
                _ => None,
            }
        };
        let code = finished.and_then(|mut s| s.child.wait().ok().map(|status| status.exit_code()));
        let _ = on_event.send(PtyEvent::Exit(code));
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
}
