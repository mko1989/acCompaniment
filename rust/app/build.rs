//! Link CoreAudio weakly on macOS (rust/DECISIONS.md ADR-018): cpal 0.18 references
//! `AudioHardwareCreateProcessTap` / `AudioHardwareDestroyProcessTap` (macOS 14.2+) for loopback
//! recording, which the app never uses. Linked normally, the binary would not start on older
//! macOS; linked weakly, those symbols are simply absent there.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,CoreAudio");
    }
}
