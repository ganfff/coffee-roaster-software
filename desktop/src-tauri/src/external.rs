use reqwest::Url;

fn browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "授权页面地址无效")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.chars().any(char::is_control)
    {
        return Err("只能打开 HTTPS 授权页面或本机 HTTP 页面".into());
    }
    Ok(url)
}

/// Hand the URL to the operating system, never to a WebView popup or a shell.
#[tauri::command]
pub fn ai_open_external(url: String) -> Result<(), String> {
    let url = browser_url(&url)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let action: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = std::ffi::OsStr::new(url.as_str())
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), action.as_ptr(), target.as_ptr(),
                std::ptr::null(), std::ptr::null(), 1)
        };
        if result as isize <= 32 {
            return Err("系统未能打开默认浏览器，请复制授权地址后手动打开".into());
        }
    }
    #[cfg(not(windows))]
    {
        let launcher = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(launcher).arg(url.as_str()).spawn()
            .map_err(|_| "系统未能打开默认浏览器，请复制授权地址后手动打开")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::browser_url;
    #[test]
    fn browser_urls_preserve_oauth_parameters_and_reject_executable_schemes() {
        let value = "https://auth.openai.com/oauth/authorize?state=a%2Bb&code_challenge=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455";
        assert_eq!(browser_url(value).unwrap().as_str(), value);
        assert!(browser_url("http://127.0.0.1:18180/login-check").is_ok());
        for value in ["javascript:alert(1)", "file:///C:/Windows/cmd.exe", "cmd:/c/start", "http://example.com", "https://user:secret@example.com", "https://example.com/\nfoo"] {
            assert!(browser_url(value).is_err(), "{value}");
        }
    }
}
