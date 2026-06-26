mod commands;
mod models;
mod pool;
mod ssh;
mod store;
mod terminal;
mod time;

use pool::SshPool;
use std::sync::Arc;
use terminal::TerminalRegistry;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(TerminalRegistry::default()))
        .manage(Arc::new(SshPool::default()))
        .manage(Arc::new(commands::UploadCancelRegistry::default()))
        .manage(Arc::new(commands::DownloadCancelRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::save_server,
            commands::delete_server,
            commands::list_command_history,
            commands::save_command_history,
            commands::test_connection,
            commands::fetch_server_status,
            commands::fetch_network_sample,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::cancel_upload,
            commands::cancel_download,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::open_terminal,
            commands::terminal_input,
            commands::terminal_resize,
            commands::terminal_snapshot,
            commands::close_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running iShell");
}
