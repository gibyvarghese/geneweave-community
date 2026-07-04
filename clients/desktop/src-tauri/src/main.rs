// SPDX-License-Identifier: MIT
//! geneWeave desktop shell (Tauri v2).
//!
//! A thin native wrapper around the geneWeave WEB BUILD (so there is no second UI to maintain — the
//! desktop app IS the web app, in a native window). It adds the desktop-only pieces the web layer
//! can't do on its own:
//!   * a GLOBAL quick-capture hotkey (Cmd/Ctrl+Shift+K) that works from any app and tells the web UI
//!     to open its quick-capture box (which the web layer already implements + tests),
//!   * a native application MENU (incl. a Quick Capture item),
//!   * single-instance (focus the existing window instead of opening a second one),
//!   * signed AUTO-UPDATES (tauri-plugin-updater; configured in tauri.conf.json).
//!
//! Offline cache + "open to last note" live in the web layer (localStorage snapshot), so they work in
//! the webview unchanged — the "Done when: launches offline and opens to last note".

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Tell the front-end (the geneWeave web UI) to open its quick-capture box.
fn emit_quick_capture(app: &tauri::AppHandle) {
    let _ = app.emit("quick-capture", ());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
}

fn main() {
    // Cmd+Shift+K on macOS, Ctrl+Shift+K elsewhere — the same combo the web UI binds in-app.
    #[cfg(target_os = "macos")]
    let capture_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
    #[cfg(not(target_os = "macos"))]
    let capture_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);

    tauri::Builder::default()
        // Focus the running window if a second instance is launched.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // A global hotkey can silently fail to register if another app owns it; when it
                    // does fire, route it to the web UI's quick-capture.
                    if shortcut == &capture_shortcut && event.state() == ShortcutState::Pressed {
                        emit_quick_capture(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Register the global quick-capture hotkey (best-effort: log + continue if it's taken).
            if let Err(e) = app.global_shortcut().register(capture_shortcut) {
                eprintln!("[geneweave-desktop] quick-capture hotkey unavailable: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the geneWeave desktop app");
}
