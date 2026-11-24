@echo off
setlocal
for %%I in ("%~dp0..") do set "ENGINE_ROOT=%%~fI"
set "CARGO_HOME=%ENGINE_ROOT%\data\toolchain\cargo"
set "RUSTUP_HOME=%ENGINE_ROOT%\data\toolchain\rustup"
set "ENGINE_RUST_BIN=%RUSTUP_HOME%\toolchains\stable-x86_64-pc-windows-msvc\bin"
set "RUSTC=%ENGINE_RUST_BIN%\rustc.exe"
set "RUSTDOC=%ENGINE_RUST_BIN%\rustdoc.exe"
set "PATH=%ENGINE_RUST_BIN%;%PATH%"
if not exist "%ENGINE_RUST_BIN%\cargo.exe" (
  echo Missing bundled Rust toolchain. See README testing-copy setup.
  exit /b 1
)
rem --offline forbids downloads. --locked preserves dependency resolution.
rem Explicit target directories keep build output within this project copy.
"%ENGINE_RUST_BIN%\cargo.exe" test --manifest-path "%ENGINE_ROOT%\runner\Cargo.toml" --target-dir "%ENGINE_ROOT%\runner\target" --locked --offline
if errorlevel 1 exit /b 1
"%ENGINE_RUST_BIN%\cargo.exe" test --manifest-path "%ENGINE_ROOT%\hftbacktest\Cargo.toml" --target-dir "%ENGINE_ROOT%\hftbacktest\target" --locked --offline -p hftbacktest --lib --no-default-features --features backtest
exit /b %errorlevel%
