//! Own the packaged, real-device HTTP service; never issue a roast/start command.
use serde_json::{json, Value};
use std::{fs::{self, File}, net::TcpListener, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool,Ordering}, Mutex}, time::{Duration,Instant}};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct DeviceState {
    child: Mutex<Option<OwnedService>>,
    pub closing: AtomicBool,
}
struct OwnedService { child: Child, url: String, token: String }

fn client() -> Result<reqwest::blocking::Client,String> {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build().map_err(|e|e.to_string())
}

impl DeviceState {
    fn start(&self, app:&tauri::AppHandle) -> Result<Value,String> {
        let mut slot=self.child.lock().map_err(|e|e.to_string())?;
        if let Some(service)=slot.as_mut() {
            if service.child.try_wait().map_err(|e|e.to_string())?.is_none(){return Ok(json!({"url":service.url}));}
        }
        let resources=app.path().resource_dir().map_err(|e|e.to_string())?;
        let program=resources.join("device").join(if cfg!(windows){"RoasterDevice.exe"}else{"RoasterDevice"});
        if !program.is_file(){return Err("控制服务运行时缺失，请重新安装完整软件".into());}
        let directory=std::env::var_os("ROASTER_APP_DATA_DIR").map(std::path::PathBuf::from)
            .unwrap_or(app.path().app_data_dir().map_err(|e|e.to_string())?).join("device");
        fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
        let listener=TcpListener::bind("127.0.0.1:0").map_err(|e|e.to_string())?;
        let port=listener.local_addr().map_err(|e|e.to_string())?.port();drop(listener);
        let mut random=[0u8;32];getrandom::fill(&mut random).map_err(|e|e.to_string())?;
        let token=random.iter().map(|n|format!("{n:02x}")).collect::<String>();
        let url=format!("http://127.0.0.1:{port}");
        let log=File::create(directory.join("service.log")).map_err(|e|e.to_string())?;
        let mut command=Command::new(program);
        command.args(["--host","127.0.0.1","--port",&port.to_string(),"--data-dir"])
            .arg(&directory).args(["--shutdown-token",&token]).stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e|e.to_string())?).stderr(log);
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn().map_err(|e|format!("控制服务无法启动：{e}"))?;
        let client=client()?;let deadline=Instant::now()+Duration::from_secs(25);
        loop {
            if child.try_wait().map_err(|e|e.to_string())?.is_some(){return Err(format!("控制服务已退出，详见 {}",directory.join("service.log").display()));}
            if let Ok(response)=client.get(format!("{url}/api/v1/runtime/health")).send(){
                if let Ok(value)=response.json::<Value>(){if value["application"]=="ganf-roaster"{break;}}
            }
            if Instant::now()>deadline {let _=child.kill();let _=child.wait();return Err("控制服务启动超时，请检查 service.log".into());}
            std::thread::sleep(Duration::from_millis(150));
        }
        *slot=Some(OwnedService{child,url:url.clone(),token});Ok(json!({"url":url}))
    }

    fn prepare_close(&self) -> Result<(),String> {
        let mut slot=self.child.lock().map_err(|e|e.to_string())?;
        let Some(service)=slot.as_mut() else{return Ok(());};
        if service.child.try_wait().map_err(|e|e.to_string())?.is_some(){*slot=None;return Ok(());}
        let response=client()?.post(format!("{}/api/v1/runtime/shutdown",service.url))
            .header("x-roaster-runtime",&service.token).send().map_err(|e|format!("无法确认设备已待机：{e}"))?;
        if !response.status().is_success(){let body=response.json::<Value>().unwrap_or_default();return Err(body["detail"].as_str().unwrap_or("请先结束本锅，再退出软件").into());}
        let deadline=Instant::now()+Duration::from_secs(5);
        while service.child.try_wait().map_err(|e|e.to_string())?.is_none(){
            if Instant::now()>deadline{let _=service.child.kill();let _=service.child.wait();break;}
            std::thread::sleep(Duration::from_millis(100));
        }
        *slot=None;Ok(())
    }
}

#[tauri::command]
pub async fn device_runtime(app:tauri::AppHandle) -> Result<Value,String> {
    tauri::async_runtime::spawn_blocking(move||app.state::<DeviceState>().start(&app)).await.map_err(|e|e.to_string())?
}

pub fn request_close(window:&tauri::Window, api:&tauri::CloseRequestApi) {
    let state=window.state::<DeviceState>();
    if state.closing.load(Ordering::SeqCst){return;}
    api.prevent_close();let window=window.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let state=window.state::<DeviceState>();
        match state.prepare_close(){
            Ok(())=>{state.closing.store(true,Ordering::SeqCst);let _=window.close();}
            Err(error)=>{let _=window.emit("device-runtime-error",error);}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read,Write};

    #[test]
    #[ignore = "child process fixture for owned service lifecycle tests"]
    fn owned_service_fixture() {
        let duration=std::env::var("ROASTER_DEVICE_TEST_SLEEP_MS").unwrap_or("200".into()).parse().unwrap();
        std::thread::sleep(Duration::from_millis(duration));
    }

    fn service(status:u16, sleep:u64)->(DeviceState,std::thread::JoinHandle<()>) {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let url=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{
            let (mut socket,_)=listener.accept().unwrap();let mut bytes=[0u8;2048];let length=socket.read(&mut bytes).unwrap();
            let request=String::from_utf8_lossy(&bytes[..length]).to_lowercase();
            assert!(request.starts_with("post /api/v1/runtime/shutdown"));assert!(request.contains("x-roaster-runtime: fixture-token"));
            let body=if status==200{"{\"stopped\":true}"}else{"{\"detail\":\"Finish this roast first\"}"};
            write!(socket,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        let child=Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact","device::tests::owned_service_fixture"])
            .env("ROASTER_DEVICE_TEST_SLEEP_MS",sleep.to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let state=DeviceState::default();*state.child.lock().unwrap()=Some(OwnedService{child,url,token:"fixture-token".into()});(state,server)
    }

    #[test]
    fn an_active_service_is_not_terminated_on_close() {
        let (state,server)=service(409,10000);
        assert_eq!(state.prepare_close().unwrap_err(),"Finish this roast first");
        let mut slot=state.child.lock().unwrap();let service=slot.as_mut().unwrap();
        assert!(service.child.try_wait().unwrap().is_none());service.child.kill().unwrap();service.child.wait().unwrap();server.join().unwrap();
    }

    #[test]
    fn an_idle_service_closes_after_authenticated_acknowledgement() {
        let (state,server)=service(200,1000);state.prepare_close().unwrap();
        assert!(state.child.lock().unwrap().is_none());server.join().unwrap();
    }
}
