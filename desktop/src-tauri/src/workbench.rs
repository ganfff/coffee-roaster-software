//! Pure offline numerical worker. No controller, serial port, or shell access.
use serde_json::Value;
use std::{io::Write, process::{Command, Stdio}};
use tauri::Manager;

#[tauri::command]
pub async fn workbench_save_file(name: String, data: Vec<u8>) -> Result<bool, String> {
    if data.len() > 64 * 1024 * 1024 { return Err("导出文件过大".into()); }
    tauri::async_runtime::spawn_blocking(move || save_file(&name, &data)).await.map_err(|e|e.to_string())?
}

#[cfg(windows)]
fn save_file(name: &str, data: &[u8]) -> Result<bool, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    let filename = std::path::Path::new(name).file_name().ok_or("无效文件名")?.to_string_lossy();
    let mut buffer = vec![0u16; 32768];
    let value: Vec<u16> = filename.encode_utf16().take(30000).collect();
    buffer[..value.len()].copy_from_slice(&value);
    let title: Vec<u16> = "保存工作台文件".encode_utf16().chain(Some(0)).collect();
    let extension: Vec<u16> = std::path::Path::new(name).extension().unwrap_or_default().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let filter: Vec<u16> = "工作台文件\0*.kpro;*.klog;*.csv;*.png;*.pdf\0所有文件\0*.*\0\0".encode_utf16().collect();
    unsafe {
        let mut dialog: OPENFILENAMEW = std::mem::zeroed();
        dialog.lStructSize=std::mem::size_of::<OPENFILENAMEW>() as u32;
        dialog.lpstrFile=buffer.as_mut_ptr();dialog.nMaxFile=buffer.len() as u32;
        dialog.lpstrTitle=title.as_ptr();dialog.lpstrFilter=filter.as_ptr();dialog.lpstrDefExt=extension.as_ptr();
        dialog.Flags=OFN_OVERWRITEPROMPT|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR|OFN_EXPLORER;
        if GetSaveFileNameW(&mut dialog)==0 {
            let error=CommDlgExtendedError();
            return if error==0 {Ok(false)} else {Err(format!("保存对话框错误：{error}"))};
        }
    }
    let end=buffer.iter().position(|&c|c==0).ok_or("无效保存路径")?;
    let target=std::path::PathBuf::from(String::from_utf16(&buffer[..end]).map_err(|e|e.to_string())?);
    let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let temp=target.with_file_name(format!(".roaster-export-{}-{stamp}.tmp",std::process::id()));
    let result=(|| {
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e|e.to_string())?;
        file.write_all(data).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
        drop(file);
        std::fs::rename(&temp,&target).map_err(|e|e.to_string())
    })();
    if result.is_err(){let _=std::fs::remove_file(&temp);}
    result.map(|_|true)
}

#[cfg(not(windows))]
fn save_file(_: &str, _: &[u8]) -> Result<bool, String> { Err("此离线文件保存入口当前仅支持 Windows".into()) }

#[tauri::command]
pub async fn workbench_request(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if bytes.len() > 24 * 1024 * 1024 { return Err("工作台请求过大".into()); }
    let root = app.path().resource_dir().map_err(|e| e.to_string())?;
    let program = root.join("workbench").join(if cfg!(windows) {"RoasterWorkbenchEngine.exe"} else {"RoasterWorkbenchEngine"});
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&program);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("离线工作台引擎无法启动：{e}"))?;
        let write_result = (|| {
            let mut input = child.stdin.take().ok_or("工作台输入不可用".to_string())?;
            input.write_all(&bytes).and_then(|_| input.write_all(b"\n")).map_err(|e| e.to_string())
        })();
        if let Err(error) = write_result { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(format!("工作台引擎退出：{}", String::from_utf8_lossy(&output.stderr))); }
        let response: Value = serde_json::from_slice(&output.stdout).map_err(|e| format!("工作台响应无效：{e}"))?;
        if response["ok"] == true { Ok(response["result"].clone()) }
        else { Err(response["error"].as_str().unwrap_or("工作台处理失败").to_string()) }
    }).await.map_err(|e| e.to_string())?
}
