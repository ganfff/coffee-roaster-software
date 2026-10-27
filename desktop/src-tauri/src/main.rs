// 桌面应用入口
// release 模式下不弹出 Windows 控制台黑窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod external;
mod workbench;
mod device;
fn main() {
    tauri::Builder::default()
        .manage(ai::AiState::default())
        .manage(ai::AiServiceState::default())
        .manage(device::DeviceState::default())
        .invoke_handler(tauri::generate_handler![
            device::device_runtime,
            external::ai_open_external,
            workbench::workbench_request,
            workbench::workbench_save_file,
            ai::ai_settings,
            ai::ai_save_settings,
            ai::ai_delete_key,
            ai::ai_run,
            ai::ai_cancel,
            ai::ai_clear_history,
            ai::ai_rpc,
            ai::ai_remote_rpc,
            ai::ai_remote_pair,
            ai::ai_remote_status,
            ai::ai_remote_clients,
            ai::ai_migrate_legacy,
            ai::ai_remote_revoke,
            ai::ai_remote_stop
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                device::request_close(window, api);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                let state = window.state::<ai::AiState>();
                window.state::<ai::AiServiceState>().shutdown();
                if let Ok(mut entries) = state.0.lock() {
                    for (_, mut child) in entries.drain() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
