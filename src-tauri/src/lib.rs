mod commands;
mod models;
mod openssh;
mod pool;
mod process_monitor;
#[cfg(russh_backend)]
mod russh_transport;
mod ssh;
mod store;
mod tail_monitor;
mod terminal;
mod time;
mod tunnel;

use pool::SshPool;
use process_monitor::ProcessMonitorRegistry;
use std::sync::Arc;
use tail_monitor::TailMonitorRegistry;
use tauri::Manager;
use terminal::TerminalRegistry;
use tunnel::TunnelRegistry;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(TerminalRegistry::default()))
        .manage(Arc::new(SshPool))
        .manage(Arc::new(ProcessMonitorRegistry::default()))
        .manage(Arc::new(TailMonitorRegistry::default()))
        .manage(Arc::new(TunnelRegistry::default()))
        .manage(Arc::new(commands::UploadCancelRegistry::default()))
        .manage(Arc::new(commands::DownloadCancelRegistry::default()))
        .setup(|app| {
            #[cfg(russh_backend)]
            {
                let handle = app.handle().clone();
                russh_transport::set_jump_resolver(Box::new(move |server| {
                    store::jump_hops(&handle, server)
                }));
            }
            #[cfg(not(russh_backend))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::save_server,
            commands::reorder_servers,
            commands::export_connections,
            commands::import_connections,
            commands::delete_server,
            commands::list_command_history,
            commands::save_command_history,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::list_port_forwards,
            commands::save_port_forward,
            commands::delete_port_forward,
            commands::start_port_forward,
            commands::stop_port_forward,
            commands::port_forward_statuses,
            commands::fetch_server_status,
            commands::start_process_monitor,
            commands::stop_process_monitor,
            commands::start_tail_monitor,
            commands::stop_tail_monitor,
            commands::fetch_network_sample,
            commands::test_server_connection,
            commands::invalidate_connection,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_download_folder,
            commands::sftp_upload,
            commands::cancel_upload,
            commands::cancel_download,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_read_text_file,
            commands::sftp_write_text_file,
            commands::open_terminal,
            commands::terminal_input,
            commands::terminal_resize,
            commands::terminal_snapshot,
            commands::close_terminal
        ])
        .build(tauri::generate_context!())
        .expect("error while building iShell")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<TunnelRegistry>>().stop_all();
            }

            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                if matches!(event, tauri::WindowEvent::Destroyed) && label.starts_with("tail-") {
                    app.state::<Arc<TailMonitorRegistry>>().stop_window(label);
                }
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            #[cfg(not(target_os = "macos"))]
            let _ = event;
        });
}
