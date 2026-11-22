//! Prints the output devices as the Rust engine sees them (B4), in the original's
//! `GET /api/audio/output-devices` form, for comparing with RtAudio's list.

fn main() {
    let mut reg = accompaniment::audio::devices::Registry::new();
    let list: Vec<serde_json::Value> = reg
        .devices()
        .iter()
        .filter(|d| d.output_channels > 0)
        .map(|d| d.to_json())
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&list).unwrap_or_default()
    );
}
