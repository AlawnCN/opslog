use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Manager, WindowEvent};

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Geometry { x: i32, y: i32, width: u32, height: u32, scale: f64, maximized: bool }

struct WindowPersistence {
    normal: Arc<Mutex<Option<Geometry>>>,
    path: std::path::PathBuf,
}

pub fn save(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return; };
    let Some(persistence) = app.try_state::<WindowPersistence>() else { return; };
    let Ok(normal) = persistence.normal.lock() else { return; };
    let Some(mut bounds) = capture(&window).or_else(|| normal.clone()) else { return; };
    bounds.maximized = window.is_maximized().unwrap_or(bounds.maximized);
    let path = &persistence.path;
    let result = (|| -> std::io::Result<()> {
        if let Some(directory) = path.parent() { std::fs::create_dir_all(directory)?; }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(&bounds).map_err(std::io::Error::other)?)?;
        std::fs::rename(temporary, path)
    })();
    if let Err(error) = result { log::warn!("Cannot save Reader window geometry: {error}"); }
}

fn capture(window: &tauri::WebviewWindow) -> Option<Geometry> {
    if window.is_minimized().ok()? || window.is_maximized().ok()? || window.is_fullscreen().ok()? { return None; }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Geometry { x: position.x, y: position.y, width: size.width, height: size.height, scale: window.scale_factor().ok()?, maximized: false })
}

// Physical positions may be negative on multi-monitor desktops. Keep normal bounds
// separately from maximized/minimized bounds; resize coordinates on a DPI change.
fn fit(saved: &Geometry, area: tauri::PhysicalRect<i32, u32>, scale: f64) -> Geometry {
    let ratio = scale / saved.scale;
    let width = ((saved.width as f64 * ratio) as u32).max((1080.0 * scale) as u32).min(area.size.width);
    let height = ((saved.height as f64 * ratio) as u32).max((700.0 * scale) as u32).min(area.size.height);
    Geometry { x: saved.x.clamp(area.position.x, area.position.x + (area.size.width - width) as i32), y: saved.y.clamp(area.position.y, area.position.y + (area.size.height - height) as i32), width, height, scale, maximized: saved.maximized }
}

pub fn initialize(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()); };
    #[cfg(target_os = "windows")]
    window.set_decorations(false)?;
    let directory = app.path().app_config_dir()?;
    let path = directory.join("reader-window.json");
    let saved = std::fs::read(&path).ok().and_then(|bytes|serde_json::from_slice::<Geometry>(&bytes).ok())
        .filter(|value|value.width>0 && value.height>0 && value.scale.is_finite() && value.scale>0.0);
    if let Some(saved) = &saved {
        let monitors = window.available_monitors()?;
        let primary = window.primary_monitor()?;
        let monitor = monitors.iter().find(|monitor| {
            let area = monitor.work_area();
            saved.x >= area.position.x && saved.x < area.position.x + area.size.width as i32
                && saved.y >= area.position.y && saved.y < area.position.y + area.size.height as i32
        }).or(primary.as_ref()).or_else(||monitors.first());
        if let Some(monitor) = monitor {
            let restored = fit(saved, *monitor.work_area(), monitor.scale_factor());
            window.set_size(tauri::PhysicalSize::new(restored.width, restored.height))?;
            window.set_position(tauri::PhysicalPosition::new(restored.x, restored.y))?;
        }
    }
    let normal = Arc::new(Mutex::new(capture(&window).or(saved.clone())));
    app.manage(WindowPersistence { normal: normal.clone(), path });
    if saved.as_ref().is_some_and(|value|value.maximized) { window.maximize()?; }
    let tracked = window.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(bounds) = capture(&tracked) { if let Ok(mut state) = normal.lock() { *state = Some(bounds); } }
            }
            WindowEvent::CloseRequested { .. } => {
                save(tracked.app_handle());
            }
            _ => {}
        }
    });
    window.show()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_dpi_and_clamps_disconnected_monitors() {
        let saved = Geometry{x: -1800,y:100,width:1200,height:800,scale:1.0,maximized:true};
        let area = tauri::PhysicalRect{position:tauri::PhysicalPosition::new(0,0),size:tauri::PhysicalSize::new(1920,1080)};
        let restored = fit(&saved,area,1.5);
        assert_eq!((restored.x,restored.y,restored.width,restored.height),(0,0,1800,1080));
        assert!(restored.maximized);
    }
}
