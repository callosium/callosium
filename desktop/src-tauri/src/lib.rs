// Callosium desktop shell (Tauri v2). A thin native wrapper around the SAME Node
// dashboard server the CLI runs — bundled under resources/payload. It:
//   • spawns the Node server on launch on an OS-ASSIGNED port and keeps it alive
//     (the brain never goes down while the app runs),
//   • confirms the server is OURS via a per-launch token handshake before showing
//     it (so a different process that happened to grab the port can't be shown),
//   • supervises the child: if it dies unexpectedly, the window says so,
//   • shows the dashboard in a window AND a tray icon,
//   • closing the window HIDES to the tray (server keeps running) so it's always
//     re-openable; Quit is the only thing that stops the server,
//   • single-instance: a second launch just re-focuses the window.
// All product logic stays in the Node engine; this file only manages process +
// window + tray lifecycle.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

/// Holds the running Node server process so we can kill it on Quit / app exit.
struct ServerProc(Mutex<Option<Child>>);
/// The dashboard URL — the port is OS-assigned at launch, so this is dynamic (not a const).
struct AppUrl(Mutex<String>);

/// Ask the OS for a free loopback port instead of hard-coding 4319 (another process — including a
/// second Callosium — may already hold a fixed port, and binding it lets that process be shown as
/// ours). We bind :0, read the assigned port, and drop the listener so the Node server can take it.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(4319)
}

/// A per-launch token the Node server echoes on /__health. Not a security boundary (loopback only),
/// just enough entropy to distinguish OUR server from any other listener on the same port.
fn launch_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("cal-{:x}-{:x}", nanos, std::process::id())
}

/// Short, writable, install-independent model cache (mirrors the portable
/// launcher). Inside the install dir the path can exceed Windows MAX_PATH and
/// onnxruntime's native file-open fails, so we anchor it in LOCALAPPDATA.
fn model_cache_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(la).join("Callosium").join("models");
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h).join(".callosium").join("models");
    }
    std::env::temp_dir().join("callosium-models")
}

/// Launch the bundled Node dashboard server on `port` with the handshake `token`. Returns the child.
fn spawn_server(app: &tauri::AppHandle, port: u16, token: &str) -> Option<Child> {
    let res = app.path().resource_dir().ok()?;
    let payload = res.join("payload");
    let node = if cfg!(windows) {
        payload.join("runtime").join("node.exe")
    } else {
        payload.join("runtime").join("bin").join("node")
    };
    let cli = payload.join("app").join("dist").join("cli.js");

    let mut cmd = Command::new(&node);
    cmd.arg(&cli)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("CALLOSIUM_MODEL_DIR", model_cache_dir())
        // Per-launch handshake token the server echoes on /__health so we can verify it's ours.
        .env("CALLOSIUM_DESKTOP_TOKEN", token)
        // Tell the server it's embedded so it does NOT also pop the system
        // browser — the app's own window already shows the dashboard.
        .env("CALLOSIUM_DESKTOP", "1");

    // Don't flash a console window for the child on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("callosium-desktop: failed to spawn server: {e}");
            None
        }
    }
}

/// Block until the local server on `port` answers /__health with OUR `token` (or give up ~90s). A
/// bare TCP-accept isn't enough — any process could be listening on that port; the token proves it's
/// the server we just spawned.
fn wait_for_server(port: u16, token: &str) -> bool {
    for _ in 0..180 {
        if health_ok(port, token) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

/// One /__health probe: connect, send a minimal HTTP/1.0 GET, and check the response body carries
/// our token. Any failure (connect/timeout/parse) is just "not ready yet".
fn health_ok(port: u16, token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(900)));
    let req = "GET /__health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    // read_to_string returns whatever arrived before the timeout / connection close; either is fine.
    let _ = stream.read_to_string(&mut buf);
    buf.contains(token)
}

fn kill_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerProc>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The dashboard URL for the current launch (empty until setup assigns the port).
fn app_url(app: &tauri::AppHandle) -> String {
    app.try_state::<AppUrl>()
        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch → just bring the existing window forward.
            show_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(ServerProc(Mutex::new(None)))
        .manage(AppUrl(Mutex::new(String::new())))
        .setup(|app| {
            // 1) pick an OS-assigned port + a per-launch token, remember the URL, start the server.
            let port = free_port();
            let token = launch_token();
            let url = format!("http://127.0.0.1:{port}");
            if let Some(state) = app.try_state::<AppUrl>() {
                if let Ok(mut g) = state.0.lock() {
                    *g = url.clone();
                }
            }
            let handle = app.handle().clone();
            let did_spawn = match spawn_server(&handle, port, &token) {
                Some(child) => {
                    *app.state::<ServerProc>().0.lock().unwrap() = Some(child);
                    true
                }
                None => false, // spawn failed (missing node.exe, resource_dir error) — the nav thread shows the error NOW, not after a 90s wait
            };

            // 2) tray icon + menu.
            let open_i = MenuItem::with_id(app, "open", "Open Callosium", true, None::<&str>)?;
            let browser_i =
                MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Callosium", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &browser_i, &sep, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("callosium-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Callosium — your brain is alive")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "browser" => {
                        use tauri_plugin_opener::OpenerExt;
                        let url = app_url(app);
                        if !url.is_empty() {
                            let _ = app.opener().open_url(url, None::<&str>);
                        }
                    }
                    "quit" => {
                        kill_server(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 3) when the server answers our handshake, navigate the window from the loading
            //    screen to the live dashboard.
            let nav_handle = app.handle().clone();
            let nav_url = url.clone();
            let nav_token = token.clone();
            std::thread::spawn(move || {
                // If the spawn itself failed, skip the ~90s handshake wait and surface the error now.
                if did_spawn && wait_for_server(port, &nav_token) {
                    if let Some(w) = nav_handle.get_webview_window("main") {
                        if let Ok(parsed) = nav_url.parse() {
                            let _ = w.navigate(parsed);
                        }
                    }
                } else if let Some(w) = nav_handle.get_webview_window("main") {
                    // The server never answered the handshake within the window — spawn failed, or it
                    // crashed on boot. Say so instead of leaving the loading screen up forever. (This
                    // also covers the spawn-failure case the supervisor can't distinguish from a Quit.)
                    let _ = w.eval(
                        r#"document.documentElement.innerHTML='<body style="margin:0;font-family:monospace;color:#fff;background:#111;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px">Callosium couldn’t start its local server.<br>Quit from the tray icon and relaunch — if it keeps happening, reinstall.</body>'"#,
                    );
                    let _ = w.show();
                }
            });

            // 4) supervise the child: if the Node server dies unexpectedly (while the app is still
            //    running, i.e. not a Quit that already took the child), tell the user in the window
            //    instead of leaving a dead "your brain is alive" tray lying.
            let sup_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(3));
                let Some(state) = sup_handle.try_state::<ServerProc>() else {
                    break;
                };
                let mut guard = match state.0.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                match guard.as_mut() {
                    // Quit/exit already reaped the child → stop supervising.
                    None => break,
                    Some(child) => match child.try_wait() {
                        Ok(Some(_status)) => {
                            // Reap it so kill_server/exit don't double-wait, then surface the failure.
                            *guard = None;
                            drop(guard);
                            if let Some(w) = sup_handle.get_webview_window("main") {
                                let _ = w.eval(
                                    r#"document.documentElement.innerHTML='<body style="margin:0;font-family:monospace;color:#fff;background:#111;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px">Callosium’s local server stopped unexpectedly.<br>Quit from the tray icon and relaunch.</body>'"#,
                                );
                                let _ = w.show();
                            }
                            break;
                        }
                        // still running, or we couldn't tell — keep watching.
                        _ => {}
                    },
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to the tray; the server keeps running so
            // the brain never goes down and re-opens instantly.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Callosium desktop app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_server(app);
            }
        });
}
