// 桌面应用入口
// release 模式下不弹出 Windows 控制台黑窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
fn main() {
    tauri::Builder::default()
        .manage(ai::AiState::default())
        .invoke_handler(tauri::generate_handler![
            ai::ai_settings,
            ai::ai_save_settings,
            ai::ai_delete_key,
            ai::ai_run,
            ai::ai_cancel,
            ai::ai_clear_history
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                let state = window.state::<ai::AiState>();
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
