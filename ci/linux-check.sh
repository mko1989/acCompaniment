#!/usr/bin/env bash
# Builds and tests the repo on Linux, in the container from ci/linux.Dockerfile. The repo is
# copied in (read-only mount; the host's node_modules, target dirs and vendor/ stay out); the
# build cache lives in docker volumes; vendor/ffmpeg is mounted from the host (npm run
# fetch:ffmpeg linux there). Pass the npm scripts to run, default: test:unit test:smoke.
# The packages it makes (package:headless) are copied to the host's dist/.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo/dist"
# Built once (REBUILD=1 to redo it): a build looks the base image up on Docker Hub every time.
if [ -n "${REBUILD:-}" ] || ! docker image inspect accompaniment-linux >/dev/null 2>&1; then
    docker build -t accompaniment-linux -f "$repo/ci/linux.Dockerfile" "$repo/ci"
fi
scripts="${*:-test:unit test:smoke}"
docker run --rm \
    -v "$repo:/src:ro" \
    -v accompaniment-linux-cargo:/usr/local/cargo/registry \
    -v accompaniment-linux-target:/work/rust/app/target \
    -v accompaniment-linux-tray-target:/work/rust/tray/target \
    -v "$repo/vendor/ffmpeg:/work/vendor/ffmpeg:ro" \
    -v "$repo/dist:/out" \
    -e SCRIPTS="$scripts" \
    accompaniment-linux bash -c '
        set -euo pipefail
        rsync -a --delete --exclude node_modules --exclude target --exclude vendor \
            --exclude test-recordings --exclude test-results --exclude dist /src/ /work/
        cd /work
        npm ci --no-audit --no-fund >/dev/null
        npm run build
        for s in $SCRIPTS; do echo "=== npm run $s"; npm run "$s"; done
        if ls dist/*.tar.gz >/dev/null 2>&1; then cp dist/*.tar.gz /out/; fi
    '
