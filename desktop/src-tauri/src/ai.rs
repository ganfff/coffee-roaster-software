use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
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

type RpcReply = Result<Value, String>;
type PendingRpc = Arc<Mutex<HashMap<String, mpsc::Sender<RpcReply>>>>;
struct ServiceProcess {
    child: Child,
    stdin: std::process::ChildStdin,
    pending: PendingRpc,
}

#[derive(Default)]
pub struct AiServiceState {
    process: Arc<Mutex<Option<ServiceProcess>>>,
    remote_generation: Arc<AtomicU64>,
    remote_backend: Arc<Mutex<Option<String>>>,
}

impl AiServiceState {
    pub fn shutdown(&self) {
        self.remote_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut slot) = self.process.lock() {
            if let Some(mut service) = slot.take() {
                let _ = service.child.kill();
                let _ = service.child.wait();
            }
        }
    }
}

fn validate_rpc(method: &str, params: &Value) -> Result<(), String> {
    const METHODS: &[&str] = &[
        "providers",
        "profiles.list",
        "profiles.save",
        "profiles.delete",
        "models",
        "test",
        "auth.login",
        "auth.respond",
        "auth.cancel",
        "auth.logout",
        "conversations.list",
        "conversations.create",
        "conversations.get",
        "conversations.update",
        "conversations.delete",
        "runs.start",
        "runs.cancel",
        "runs.events",
        "tools.respond",
        "attachments.add",
        "attachments.get",
        "attachments.delete",
        "legacy.import",
    ];
    if !METHODS.contains(&method) || !params.is_object() || params.to_string().len() > 16_000_000 {
        return Err("AI 请求格式错误".into());
    }
    Ok(())
}

fn service_master() -> Result<String, String> {
    const NAME: &str = "RoasterAI:host-master:v1";
    if let Some(value) = credential(NAME, None)? {
        return Ok(value);
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let value = base64::engine::general_purpose::STANDARD.encode(bytes);
    bytes.fill(0);
    credential(NAME, Some(&value))?;
    Ok(value)
}

fn send_rpc(
    service: &mut ServiceProcess,
    method: &str,
    params: Value,
) -> Result<mpsc::Receiver<RpcReply>, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let (sender, receiver) = mpsc::channel();
    service
        .pending
        .lock()
        .map_err(|_| "AI 请求锁错误")?
        .insert(id.clone(), sender);
    let line = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
        .map_err(|e| e.to_string())?;
    if let Err(error) = service
        .stdin
        .write_all(&line)
        .and_then(|_| service.stdin.write_all(b"\n"))
        .and_then(|_| service.stdin.flush())
    {
        if let Ok(mut pending) = service.pending.lock() {
            pending.remove(&id);
        }
        return Err(error.to_string());
    }
    Ok(receiver)
}

fn receive_rpc(receiver: mpsc::Receiver<RpcReply>) -> RpcReply {
    receiver
        .recv_timeout(std::time::Duration::from_secs(65))
        .map_err(|_| "AI 服务请求超时；请求不会自动重发".to_string())?
}

fn start_service(app: &tauri::AppHandle) -> Result<ServiceProcess, String> {
    let (mut node, mut entry) = (
        app.path()
            .resolve("ai-node.exe", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?,
        app.path()
            .resolve("ai/service.mjs", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?,
    );
    if cfg!(debug_assertions) {
        let runtime = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime");
        node = runtime.join("ai-node-x86_64-pc-windows-msvc.exe");
        entry = runtime.join("ai/service.mjs");
    }
    let mut command = Command::new(node);
    command
        .arg(entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("AI 运行时启动失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("AI 输出不可用")?;
    let stdin = child.stdin.take().ok_or("AI 输入不可用")?;
    let pending: PendingRpc = Arc::default();
    let reader_pending = pending.clone();
    let events = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.len() > 20_000_000 {
                break;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let kind = event["type"].as_str().unwrap_or("");
            let id = event["id"].as_str().unwrap_or("");
            let sender = if kind == "result" || kind == "error" {
                reader_pending
                    .lock()
                    .ok()
                    .and_then(|mut entries| entries.remove(id))
            } else {
                None
            };
            if let Some(sender) = sender {
                let response = if kind == "result" {
                    Ok(event["data"].clone())
                } else {
                    Err(event["data"]["message"]
                        .as_str()
                        .unwrap_or("AI 请求失败")
                        .to_string())
                };
                let _ = sender.send(response);
            } else {
                let _ = events.emit_to("main", "roaster-ai-service", event);
            }
        }
        if let Ok(mut entries) = reader_pending.lock() {
            for (_, sender) in entries.drain() {
                let _ = sender.send(Err("AI 服务已停止；请求不会自动重发".into()));
            }
        }
        let _ = events.emit_to("main", "roaster-ai-service", json!({"id":"host","type":"host_error","data":{"message":"AI 服务已停止，可重新发起请求"}}));
    });
    let mut service = ServiceProcess {
        child,
        stdin,
        pending,
    };
    let initialization = (|| {
        let receiver = send_rpc(
            &mut service,
            "initialize",
            json!({"data_dir":dir(app)?.join("host"),"master_key":service_master()?}),
        )?;
        receive_rpc(receiver)
    })();
    if let Err(error) = initialization {
        let _ = service.child.kill();
        let _ = service.child.wait();
        return Err(error);
    }
    // Import old local settings/history once; preserve every legacy file and key.
    if let Ok(settings) = config(app) {
        if !settings["provider"].as_str().unwrap_or("").is_empty()
            && !settings["model"].as_str().unwrap_or("").is_empty()
        {
            let mut conversations = Vec::new();
            if let Ok(entries) = fs::read_dir(dir(app)?) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.len() != 21
                        || !name.ends_with(".json")
                        || !name[..16].chars().all(|c| c.is_ascii_hexdigit())
                    {
                        continue;
                    }
                    if let Ok(bytes) = fs::read(entry.path()) {
                        if let Ok(messages) = serde_json::from_slice::<Value>(&bytes) {
                            if messages.as_array().map(|v| !v.is_empty()).unwrap_or(false) {
                                conversations.push(json!({"title":"旧版对话","messages":messages}));
                            }
                        }
                    }
                }
            }
            let imported = (|| {
                let api_key = credential(&credential_name(&settings), None)?;
                receive_rpc(send_rpc(
                    &mut service,
                    "legacy.import",
                    json!({"import_id":"windows-v1","settings":settings,"api_key":api_key,"conversations":conversations}),
                )?)
            })();
            if let Err(error) = imported {
                let _ = app.emit_to(
                    "main",
                    "roaster-ai-service",
                    json!({"id":"host","type":"migration_warning","data":{"message":error}}),
                );
            }
        }
    }
    Ok(service)
}

#[tauri::command]
pub async fn ai_rpc(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AiServiceState>,
    method: String,
    params: Option<Value>,
) -> RpcReply {
    if window.label() != "main" {
        return Err("此窗口不能调用 AI".into());
    }
    let params = params.unwrap_or(json!({}));
    validate_rpc(&method, &params)?;
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let receiver = {
            let mut slot = process.lock().map_err(|_| "AI 服务锁错误")?;
            if slot
                .as_mut()
                .map(|s| s.child.try_wait().ok().flatten().is_some())
                .unwrap_or(false)
            {
                *slot = None;
            }
            if slot.is_none() {
                *slot = Some(start_service(&app)?);
            }
            send_rpc(slot.as_mut().unwrap(), &method, params)?
        };
        receive_rpc(receiver)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backend_origin(backend: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(backend).map_err(|_| "AI 宿主地址无效")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/"].contains(&url.path())
    {
        return Err("AI 宿主需为不含凭据和路径的 HTTP(S) 地址".into());
    }
    Ok(url.origin().ascii_serialization())
}
fn remote_name(backend: &str) -> String {
    format!("RoasterAI:remote:{}", key(backend))
}
fn remote_token(backend: &str) -> Result<String, String> {
    let raw = credential(&remote_name(backend), None)?.ok_or("请先配对远程 AI 宿主")?;
    let saved: Value = serde_json::from_str(&raw).map_err(|_| "远程 AI 凭据格式错误")?;
    if saved["backend"] != backend {
        return Err("远程 AI 宿主与配对凭据不符".into());
    }
    saved["token"]
        .as_str()
        .map(String::from)
        .ok_or("远程 AI 配对凭据缺失".into())
}
fn remote_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(70))
        .build()
        .map_err(|e| e.to_string())
}
async fn remote_response(response: reqwest::Response) -> RpcReply {
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| "AI 宿主响应格式错误")?;
    if !status.is_success() {
        return Err(value["detail"].as_str().unwrap_or("AI 宿主请求失败").into());
    }
    Ok(value)
}
fn start_remote_events(
    app: tauri::AppHandle,
    state: &AiServiceState,
    backend: String,
) -> Result<(), String> {
    let token = remote_token(&backend)?;
    let client = remote_client()?;
    let mut selected = state.remote_backend.lock().map_err(|_| "AI 宿主锁错误")?;
    if selected.as_ref() == Some(&backend) {
        return Ok(());
    }
    *selected = Some(backend.clone());
    let generation = state.remote_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.remote_generation.clone();
    let selected_backend = state.remote_backend.clone();
    tauri::async_runtime::spawn(async move {
        let mut cursor = 0u64;
        while current.load(Ordering::SeqCst) == generation {
            let result = client
                .get(format!("{backend}/api/v1/ai/events"))
                .bearer_auth(&token)
                .query(&[
                    ("after", cursor.to_string()),
                    ("timeout_ms", "20000".into()),
                ])
                .send()
                .await;
            if current.load(Ordering::SeqCst) != generation {
                break;
            }
            match result {
                Ok(response) => match remote_response(response).await {
                    Ok(batch) => {
                        if current.load(Ordering::SeqCst) != generation {
                            break;
                        }
                        cursor = batch["cursor"].as_u64().unwrap_or(cursor);
                        if batch["replay_required"] == true {
                            let _=app.emit_to("main","roaster-ai-service",json!({"id":"host","type":"replay_required","host":backend,"data":{}}));
                        }
                        if let Some(events) = batch["events"].as_array() {
                            for event in events {
                                let mut event = event.clone();
                                event["host"] = json!(backend);
                                let _ = app.emit_to("main", "roaster-ai-service", event);
                            }
                        }
                    }
                    Err(error) => {
                        let _=app.emit_to("main","roaster-ai-service",json!({"id":"host","type":"host_error","host":backend,"data":{"message":error}}));
                        break;
                    }
                },
                Err(_) => {
                    let _=app.emit_to("main","roaster-ai-service",json!({"id":"host","type":"host_error","host":backend,"data":{"message":"AI 宿主连接中断；可重新连接，已发送请求不会重发"}}));
                    break;
                }
            }
        }
        if current.load(Ordering::SeqCst) == generation {
            if let Ok(mut selected) = selected_backend.lock() {
                *selected = None;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn ai_remote_pair(backend: String, code: String, name: Option<String>) -> RpcReply {
    let backend = backend_origin(&backend)?;
    let mut value = remote_response(
        remote_client()?
            .post(format!("{backend}/api/v1/ai/pair"))
            .header("X-Roaster-Native", "1")
            .json(&json!({"code":code,"name":name.unwrap_or("Windows 桌面".into()),"native":true}))
            .send()
            .await
            .map_err(|_| "无法连接 AI 宿主")?,
    )
    .await?;
    let token = value
        .as_object_mut()
        .and_then(|object| object.remove("token"))
        .and_then(|v| v.as_str().map(String::from))
        .ok_or("AI 宿主未返回原生配对凭据")?;
    credential(
        &remote_name(&backend),
        Some(&json!({"backend":backend,"token":token}).to_string()),
    )?;
    Ok(value)
}
#[tauri::command]
pub async fn ai_remote_status(backend: String) -> RpcReply {
    let backend = backend_origin(&backend)?;
    let mut request = remote_client()?.get(format!("{backend}/api/v1/ai/status"));
    if let Ok(token) = remote_token(&backend) {
        request = request.bearer_auth(token);
    }
    remote_response(request.send().await.map_err(|_| "无法连接 AI 宿主")?).await
}
#[tauri::command]
pub async fn ai_remote_rpc(
    app: tauri::AppHandle,
    state: tauri::State<'_, AiServiceState>,
    backend: String,
    method: String,
    params: Option<Value>,
) -> RpcReply {
    let backend = backend_origin(&backend)?;
    let params = params.unwrap_or(json!({}));
    validate_rpc(&method, &params)?;
    let token = remote_token(&backend)?;
    start_remote_events(app, &state, backend.clone())?;
    remote_response(
        remote_client()?
            .post(format!("{backend}/api/v1/ai/rpc"))
            .bearer_auth(token)
            .json(&json!({"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| "AI 宿主连接失败；请求不会自动重发")?,
    )
    .await
}
#[tauri::command]
pub async fn ai_remote_clients(backend: String) -> RpcReply {
    let backend = backend_origin(&backend)?;
    remote_response(
        remote_client()?
            .get(format!("{backend}/api/v1/ai/clients"))
            .bearer_auth(remote_token(&backend)?)
            .send()
            .await
            .map_err(|_| "AI 宿主连接失败")?,
    )
    .await
}

/// Explicitly migrate legacy data host-to-host. Secrets never enter the WebView.
#[tauri::command]
pub async fn ai_migrate_legacy(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AiServiceState>,
    backend: String,
) -> RpcReply {
    if window.label() != "main" {
        return Err("此窗口不能迁移 AI 数据".into());
    }
    let settings = config(&app)?;
    let mut profiles = Vec::new();
    if !settings["provider"].as_str().unwrap_or("").is_empty() {
        let mut profile = settings.clone();
        profile["api_key"] = json!(credential(&credential_name(&settings), None)?);
        profiles.push(profile);
    }
    let mut conversations = Vec::new();
    for entry in fs::read_dir(dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.len() != 21 || !name.ends_with(".json")
            || !name[..16].chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        if let Ok(bytes) = fs::read(entry.path()) {
            if let Ok(messages) = serde_json::from_slice::<Value>(&bytes) {
                if messages.as_array().map(|v| !v.is_empty()).unwrap_or(false) {
                    conversations.push(json!({"title":format!("旧版对话 {}",&name[..8]),"messages":messages}));
                }
            }
        }
    }
    let payload = json!({
        "import_id":format!("windows-legacy-{}",key(&service_master()?)),
        "profiles":profiles,"conversations":conversations
    });
    ai_remote_rpc(app,state,backend,"legacy.import".into(),Some(payload)).await
}
#[tauri::command]
pub async fn ai_remote_revoke(backend: String, id: String) -> RpcReply {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) || id.len() > 64 {
        return Err("客户端 ID 无效".into());
    }
    let backend = backend_origin(&backend)?;
    remote_response(
        remote_client()?
            .delete(format!("{backend}/api/v1/ai/clients/{id}"))
            .bearer_auth(remote_token(&backend)?)
            .send()
            .await
            .map_err(|_| "AI 宿主连接失败")?,
    )
    .await
}
#[tauri::command]
pub fn ai_remote_stop(state: tauri::State<AiServiceState>) -> Result<(), String> {
    state.remote_generation.fetch_add(1, Ordering::SeqCst);
    *state.remote_backend.lock().map_err(|_| "AI 宿主锁错误")? = None;
    Ok(())
}

fn key(value: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let path = std::env::var_os("ROASTER_APP_DATA_DIR").map(std::path::PathBuf::from)
        .unwrap_or(app.path().app_data_dir().map_err(|e|e.to_string())?).join("ai");
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
    #[test]
    fn remote_origin_excludes_credentials_paths_and_redirect_targets() {
        assert_eq!(
            backend_origin("http://127.0.0.1:8000/").unwrap(),
            "http://127.0.0.1:8000"
        );
        assert_eq!(
            backend_origin("https://ROASTER.local").unwrap(),
            "https://roaster.local"
        );
        for invalid in [
            "file:///etc/passwd",
            "http://user:secret@host",
            "https://host/else",
            "https://host?key=x",
            "https://host#x",
        ] {
            assert!(backend_origin(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn rpc_allowlist_has_no_host_initialization_or_hardware_commands() {
        assert!(validate_rpc("providers", &json!({})).is_ok());
        for invalid in [
            "initialize",
            "start",
            "controller.start",
            "set_sv",
            "workbench",
        ] {
            assert!(validate_rpc(invalid, &json!({})).is_err());
        }
        assert!(validate_rpc("providers", &json!([])).is_err());
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
