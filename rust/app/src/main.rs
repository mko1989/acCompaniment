use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    accompaniment::server::run().await
}
