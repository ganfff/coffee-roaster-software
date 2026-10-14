use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct AiState(pub Arc<Mutex<HashMap<String, Child>>>);

fn key(value: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn config(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = dir(app)?.join("settings.json");
    if !path.exists() {
        return Ok(json!({"provider":"","model":"","base_url":""}));
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn credential_name(config: &Value) -> String {
    format!(
        "RoasterAI:{}",
        key(&format!("{}|{}", config["provider"], config["base_url"]))
    )
}

#[cfg(windows)]
fn credential(name: &str, update: Option<&str>) -> Result<Option<String>, String> {
    use windows_sys::Win32::Security::Credentials::*;
    let mut target: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    unsafe {
        if let Some(secret) = update {
            if secret.is_empty() {
                CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0);
                return Ok(None);
            }
            let mut bytes = secret.as_bytes().to_vec();
            let mut user: Vec<u16> = "RoasterAI".encode_utf16().chain(Some(0)).collect();
            let value = CREDENTIALW {
                Flags: 0,
                Type: CRED_TYPE_GENERIC,
                TargetName: target.as_mut_ptr(),
                Comment: std::ptr::null_mut(),
                LastWritten: std::mem::zeroed(),
                CredentialBlobSize: bytes.len() as u32,
                CredentialBlob: bytes.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                AttributeCount: 0,
                Attributes: std::ptr::null_mut(),
                TargetAlias: std::ptr::null_mut(),
                UserName: user.as_mut_ptr(),
            };
            let ok = CredWriteW(&value, 0);
            bytes.fill(0);
            if ok == 0 {
                return Err(format!(
                    "Windows 凭据保存失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            return Ok(None);
        }
        let mut pointer = std::ptr::null_mut();
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(1168) {
                return Ok(None);
            }
            return Err(format!("Windows 凭据读取失败：{error}"));
        }
        let value = &*pointer;
        let secret = String::from_utf8(
            std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize)
                .to_vec(),
        );
        CredFree(pointer as *const _);
        secret.map(Some).map_err(|_| "凭据编码错误".into())
    }
}
#[cfg(not(windows))]
fn credential(_: &str, _: Option<&str>) -> Result<Option<String>, String> {
    Err("第一版密钥存储仅支持 Windows".into())
}

#[tauri::command]
pub fn ai_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let mut cfg = config(&app)?;
    cfg["configured"] = json!(credential(&credential_name(&cfg), None)?.is_some());
    Ok(cfg)
}
#[tauri::command]
pub fn ai_save_settings(app: tauri::AppHandle, mut settings: Value) -> Result<Value, String> {
    let secret = settings
        .as_object_mut()
        .ok_or("设置格式错误")?
        .remove("api_key");
    settings.as_object_mut().unwrap().remove("configured");
    let provider = settings["provider"].as_str().ok_or("请选择服务商")?;
    if ![
        "openai",
        "anthropic",
        "google",
        "deepseek",
        "moonshotai-cn",
        "openrouter",
        "custom",
    ]
    .contains(&provider)
    {
        return Err("未知服务商".into());
    }
    let provider = provider.to_owned();
    let model = settings["model"].as_str().unwrap_or("").trim().to_owned();
    let base = if provider == "custom" {
        settings["base_url"]
            .as_str()
            .unwrap_or("")
            .trim()
            .trim_end_matches('/')
            .to_owned()
    } else {
        String::new()
    };
    if model.len() > 200 || base.len() > 2048 {
        return Err("模型或地址过长".into());
    }
    if provider == "custom"
        && (!(base.starts_with("http://") || base.starts_with("https://"))
            || base.contains(['@', '?', '#']))
    {
        return Err("自定义地址需为 HTTP(S) API 根地址，密钥请单独设置".into());
    }
    settings = json!({"provider":provider,"model":model,"base_url":base});
    if let Some(secret) = secret.and_then(|v| v.as_str().map(String::from)) {
        if !secret.is_empty() {
            credential(&credential_name(&settings), Some(&secret))?;
        }
    }
    let path = dir(&app)?.join("settings.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    ai_settings(app)
}
#[tauri::command]
pub fn ai_delete_key(app: tauri::AppHandle) -> Result<(), String> {
    credential(&credential_name(&config(&app)?), Some(""))?;
    Ok(())
}
#[tauri::command]
pub fn ai_cancel(state: tauri::State<AiState>, id: String) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().map_err(|_| "AI 状态锁错误")?.remove(&id) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
#[tauri::command]
pub fn ai_clear_history(app: tauri::AppHandle, storage_key: String) -> Result<(), String> {
    let path = dir(&app)?.join(format!("{}.json", key(&storage_key)));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_run(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AiState>,
    mut request: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能调用 AI".into());
    }
    let id = request["id"].as_str().ok_or("缺少请求 ID")?.to_owned();
    let kind = request["kind"].as_str().ok_or("缺少请求类型")?;
    if !["review", "design", "live", "models", "test"].contains(&kind) || id.len() > 100 {
        return Err("请求格式错误".into());
    }
    if request.to_string().len() > 2_000_000 {
        return Err("分析数据过大，请选择更短的数据区间".into());
    }
    let cfg = config(&app)?;
    request["apiKey"] = json!(credential(&credential_name(&cfg), None)?);
    request["config"] = cfg;
    let storage = request["storage_key"].as_str().unwrap_or(&id).to_owned();
    let history_path = dir(&app)?.join(format!("{}.json", key(&storage)));
    request["history"] = fs::read(&history_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!([]));
    let mut worker = app
        .path()
        .resolve("ai/worker.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let mut node = app
        .path()
        .resolve("ai-node.exe", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if cfg!(debug_assertions) {
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime");
        worker = runtime.join("ai/worker.mjs");
        node = runtime.join("ai-node-x86_64-pc-windows-msvc.exe");
    }
    let mut command = Command::new(node);
    command
        .arg(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut children = state.0.lock().map_err(|_| "AI 状态锁错误")?;
    if children.len() >= 2 || children.contains_key(&id) {
        return Err("已有分析正在运行，请稍后重试".into());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("AI 运行环境启动失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("AI 输出不可用")?;
    let mut stdin = child.stdin.take().ok_or("AI 输入不可用")?;
    let input = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if let Err(e) = stdin.write_all(&input).and_then(|_| stdin.write_all(b"\n")) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e.to_string());
    }
    drop(stdin);
    children.insert(id.clone(), child);
    drop(children);
    let managed = Arc::clone(&state.0);
    std::thread::spawn(move || {
        let mut terminal = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.len() > 2_000_000 {
                break;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if event["id"] != id {
                continue;
            }
            if event["type"] == "history" {
                if let Ok(bytes) = serde_json::to_vec(&event["data"]) {
                    let _ = fs::write(&history_path, bytes);
                }
                continue;
            }
            if event["type"] == "done" || event["type"] == "error" {
                terminal = true;
            }
            let _ = app.emit_to(window.label(), "roaster-ai", event);
        }
        if let Ok(mut entries) = managed.lock() {
            if let Some(mut child) = entries.remove(&id) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if !terminal {
            let _ = app.emit_to(
                window.label(),
                "roaster-ai",
                json!({"id":id,"type":"error","data":"AI 进程已停止，原稿保持不变"}),
            );
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_keys_isolate_backends() {
        assert_ne!(
            key("http://machine-a|record|one"),
            key("http://machine-b|record|one")
        );
    }
    #[cfg(windows)]
    #[test]
    fn windows_credential_roundtrip_without_user_secrets() {
        let name = format!(
            "RoasterAI-QA-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        assert!(credential(&name, None).unwrap().is_none());
        credential(&name, Some("local-qa-placeholder")).unwrap();
        let read = credential(&name, None);
        credential(&name, Some("")).unwrap();
        assert_eq!(read.unwrap(), Some("local-qa-placeholder".into()));
        assert!(credential(&name, None).unwrap().is_none());
    }
}
