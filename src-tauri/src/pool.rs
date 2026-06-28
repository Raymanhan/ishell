use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use ssh2::{Session, Sftp};
use tauri::AppHandle;

use crate::{ssh::connect_server, store::mark_connected};

/// A pooled SSH connection plus its lazily-opened SFTP subsystem. Caching the
/// `Sftp` handle is what makes directory navigation feel instant: without it
/// every listing re-opens the SFTP channel (an extra multi-round-trip
/// handshake) on top of the `readdir` itself.
struct Conn {
    session: Session,
    sftp: Option<Sftp>,
}

/// Caches live connections per server so repeated SFTP operations and status
/// sampling avoid paying a full TCP + handshake + auth round trip every time.
/// Monitoring uses a separate session from SFTP so a long upload/download does
/// not freeze live charts. The interactive terminal keeps its own dedicated
/// connection (it runs non-blocking with a long-lived shell).
#[derive(Default)]
pub struct SshPool {
    conns: Mutex<HashMap<String, Arc<Mutex<Conn>>>>,
    monitor_conns: Mutex<HashMap<String, Arc<Mutex<Conn>>>>,
}

impl SshPool {
    pub fn invalidate(&self, id: &str) {
        if let Ok(mut map) = self.conns.lock() {
            map.remove(id);
        }
        if let Ok(mut map) = self.monitor_conns.lock() {
            map.remove(id);
        }
    }

    fn cached(
        map: &Mutex<HashMap<String, Arc<Mutex<Conn>>>>,
        id: &str,
    ) -> Option<Arc<Mutex<Conn>>> {
        map.lock().ok()?.get(id).cloned()
    }

    fn get_or_connect(
        &self,
        app: &AppHandle,
        id: &str,
        monitor: bool,
    ) -> Result<Arc<Mutex<Conn>>, String> {
        let map = if monitor {
            &self.monitor_conns
        } else {
            &self.conns
        };
        if let Some(arc) = Self::cached(map, id) {
            let alive = arc
                .lock()
                .map(|conn| conn.session.keepalive_send().is_ok())
                .unwrap_or(false);
            if alive {
                return Ok(arc);
            }
            if let Ok(mut map) = map.lock() {
                map.remove(id);
            }
        }

        let (session, _server) = connect_server(app, id)?;
        session.set_keepalive(true, 30);
        mark_connected(app, id).ok();

        let arc = Arc::new(Mutex::new(Conn {
            session,
            sftp: None,
        }));
        if let Ok(mut map) = map.lock() {
            map.insert(id.to_string(), arc.clone());
        }
        Ok(arc)
    }
}

/// Run a closure against the monitoring session. This intentionally does not
/// share the SFTP session so uploads/downloads cannot stall live charts.
pub fn with_monitor_session<T>(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    action: impl FnOnce(&Session) -> Result<T, String>,
) -> Result<T, String> {
    let arc = pool.get_or_connect(app, id, true)?;
    let conn = arc.lock().map_err(|_| "SSH 会话繁忙，请重试".to_string())?;
    action(&conn.session)
}

/// Run a closure against the pooled (and cached) SFTP handle.
pub fn with_sftp<T>(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    action: impl FnOnce(&Sftp) -> Result<T, String>,
) -> Result<T, String> {
    let arc = pool.get_or_connect(app, id, false)?;
    let mut conn = arc.lock().map_err(|_| "SSH 会话繁忙，请重试".to_string())?;

    if conn.sftp.is_none() {
        let sftp = conn
            .session
            .sftp()
            .map_err(|err| format!("无法打开 SFTP 会话：{err}"))?;
        conn.sftp = Some(sftp);
    }

    let result = action(conn.sftp.as_ref().expect("sftp just initialized"));
    if result.is_err() {
        // Drop the cached handle so a fresh one is opened next time in case the
        // SFTP channel (not the whole session) went into a bad state.
        conn.sftp = None;
    }
    result
}

/// Run a closure against the pooled SSH session and cached SFTP handle.
pub fn with_sftp_session<T>(
    pool: &SshPool,
    app: &AppHandle,
    id: &str,
    action: impl FnOnce(&Session, &Sftp) -> Result<T, String>,
) -> Result<T, String> {
    let arc = pool.get_or_connect(app, id, false)?;
    let mut conn = arc.lock().map_err(|_| "SSH 会话繁忙，请重试".to_string())?;

    if conn.sftp.is_none() {
        let sftp = conn
            .session
            .sftp()
            .map_err(|err| format!("无法打开 SFTP 会话：{err}"))?;
        conn.sftp = Some(sftp);
    }

    let result = action(&conn.session, conn.sftp.as_ref().expect("sftp just initialized"));
    if result.is_err() {
        conn.sftp = None;
    }
    result
}
