# A Linux machine for the server's first runs (Wave C): Ubuntu 22.04 (as the CI runner) with
# Node 22 and Rust stable, plus what the server (ALSA) and the tray app (WebKitGTK,
# appindicator) build against. No audio device: the server runs as on a machine without one
# (WO-012's case).
#   ci/linux-check.sh            (builds the image, then builds and tests the repo in it)
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils build-essential pkg-config libasound2-dev rsync lsof procps \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz \
        | tar -xJ -C /usr/local --strip-components=1
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt
# The tray app (Tauri): only needed for `cargo build`/`test` in rust/tray.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
