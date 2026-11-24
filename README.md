# HFT Engine for Windows

This private repository contains the Windows source and build tooling for the HFT
engine. Sierra Chart data, replay recordings, model weights and journals stay local.
See the [repository workflow](docs/publish.md) for branch and test details.

The Windows engine combines a live MNQ market-data dashboard, paper execution,
historical backtesting and recorded-session replay. It uses
[hftbacktest](https://github.com/nkaz001/hftbacktest) for its Rust historical runner
and a Sierra Chart publisher for Windows market and simulated-account snapshots.
The dashboard displays the order book, queue estimates, tape, simulated orders and
fills, latency, position, fees, equity, journals and daily performance.

`main` contains the reviewed source baseline. The current Windows testing source,
kill switch and automated tests are on `Test`. The features described below refer
to that testing engine. Recorded progress and pending work are listed in the
[Windows task register](https://github.com/saintflds/HFT-Engine-Windows/blob/Test/TASKS.md).

## Before you think about trading this

The live dashboard reads Sierra market-data publications and can run engine paper
strategies against them. Historical sessions run through the Rust backtest engine.
Order routing from the application into Sierra Sim1 or a live broker remains pending.

1. **Fees.** The historical runner and paper simulator account for configured costs.
   Check the per-contract fee, order quantity and instrument settings for each run.
2. **Latency.** Historical entry and response delays are modeled inputs. Live feed
   timestamps and publication freshness affect the paper engine's view of the market.
   Broker acknowledgments and end-to-end live execution latency still need integration
   and verification.
3. **Fills are modelled.** Native depth, quote-only reconstruction and sampled live
   snapshots provide different information. Queue estimates, fills and cancellations
   depend on the available observations and the selected execution model.
4. **P&L is simulated.** The engine tracks position, balance, fees and net equity for
   historical and paper runs. The Sierra account view also displays the simulated
   account information supplied by the native publisher.

The shared paper-execution kill switch blocks new simulated routing, cancels through
the simulator, persists stop state and requires operator authorization to reset.
Configured risk conditions can activate it automatically. Its scope and verification
are documented in the
[kill-switch guide](https://github.com/saintflds/HFT-Engine-Windows/blob/Test/docs/emergency-kill-switch.md).

```
HFT-Engine-Windows/
  hftbacktest/      pinned upstream backtest engine submodule
  patches/          read-only queue-position getter patch and attribution
  runner/           Rust historical strategies, accounting and HBR frame recorder
  dashboard/        TypeScript dashboard, server modules and synthetic tests
  tools/            collection, conversion and replay-inspection utilities
    sierra/         Windows Sierra publisher and historical format utilities
  docs/             paper kill-switch guide and repository workflow
  .github/          Windows automated build and offline test workflow
  TASKS.md          work recorded, test evidence and pending capabilities on Test
  data/             local inputs, runtime state and generated output, ignored by Git
```

## What is live and what is modelled

| On screen | Source |
| --- | --- |
| Live MNQ book and tape | Sierra snapshots published by the Windows study and streamed to the dashboard. Available data depends on chart connection, replay mode and publication freshness. |
| Sierra account view | Simulated positions, orders and executions read by the native publisher. |
| Engine paper orders and fills | Local execution simulation driven by observed frames, with modeled queues, delays, fills and cancellations. |
| Historical MNQ order book | Recorded Sierra depth files, or saved best quotes reconstructed from SCID ticks in quote-only mode. |
| Historical strategy | Rust runner with queue, grid and EMA strategies, configured fees, latency and sizing. |
| Binance replay | Locally collected public streams converted into historical inputs and HBR recordings. |
| Paper risk controls | Shared server kill switch, exposure checks, configured loss/disconnection triggers and authorization at the simulated routing boundary. |
| Journaling and learning | Local journals, adaptive outcomes, training examples and predictor qualification checks. Predictor use depends on qualification and compatible inputs. |
| Daily performance | Saved paper journals and recorded replay accounting, subject to costs, coverage and replay-time rules. |

Recorded market data, account settings, model files, trading journals and generated
replay sessions are excluded from the GitHub source repository.

## Get the code

The historical runner's dependency is a pinned Git submodule with read-only queue
position getters. Clone the testing branch recursively to obtain the current Windows
testing source and the dependency's source.

```powershell
git clone --branch Test --recurse-submodules https://github.com/saintflds/HFT-Engine-Windows.git
cd HFT-Engine-Windows
```

For an existing clone, select `Test` and run `git submodule update --init`.
In GitHub Desktop, choose **Current branch → Test** and pull the latest changes.

## Setup (Windows, done once)

The dashboard was verified with Node 24.22.1. The Sierra file-format tests passed
with Python 3.14 and use the standard library. A fresh historical runner build needs
Rust with the MSVC toolchain and compatible Windows C++ build tools.

```powershell
# Dashboard dependencies from the committed lockfile
cd dashboard
npm.cmd ci --ignore-scripts --no-audit --no-fund
cd ..

# Synthetic Sierra format tests
py -3.14 -m unittest discover -s tools/sierra -p test_session.py

# Historical runner, after installing the Rust/MSVC prerequisites
cargo build --release --locked --manifest-path runner/Cargo.toml
```

The optional `tools/setup-sierra-python.ps1` helper prepares the local environment
and installs the pinned NumPy dependency for `tools/hbr.py`. That helper was previously
verified with Python 3.15.1 on Windows x64. The upstream Binance Python conversion
stack requires additional packages and compatible Python versions.

The native Sierra build helper at `tools/sierra/build.cmd` uses a local Visual Studio
Build Tools path and sibling `SierraChart/ACS_Source` headers. Check these installation
paths before building. The original local Rust cache helper, `tools/check-backtest.cmd`,
requires the toolchain and cache under `data/toolchain/`, which are excluded from Git.

## Record your own data

The Sierra publisher writes market snapshots into the selected Windows engine's
`data/sierra/latest.json`. The server streams these snapshots to the live dashboard.
Compiling the study, configuring an active Sierra chart and verifying its publications
are separate local setup steps. Full active-chart integration remains unverified in
the GitHub setup.

The original Binance collector remains available after preparing its collector binary
and Python environment.

```powershell
.venv/Scripts/python.exe tools/collect.py start --symbols BTCUSDT ETHUSDT
.venv/Scripts/python.exe tools/collect.py status
.venv/Scripts/python.exe tools/collect.py stop
```

Public-stream recordings are written under `data/raw/`. Keep recordings and licensed
market data in local storage. The repository excludes recorded sample sessions too.

## Build a session and replay it

Use a local recording you are authorized to use and a built historical runner.
The Binance conversion workflow also requires its upstream Python dependencies.

```powershell
.venv/Scripts/python.exe tools/session.py --raw data/raw/btcusdt_20260915.gz --name btcusdt_20260915
cd dashboard
npm.cmd run dev
```

Open `http://127.0.0.1:5180/?session=btcusdt_20260915` after the build completes.
The builder converts the recording, derives latency, runs the engine and stages
the HBR output and provenance files in `dashboard/public/sessions/`.

| session | content |
| --- | --- |
| Binance replay | A named session built from locally collected public streams. |
| Sierra depth replay | A named MNQ session built from SCID trades and matching native depth files. |
| Sierra quote replay | A named session built from SCID trades and saved best quotes, assuming one contract at each observed best bid/ask. |

On `Test`, open `/?sierra=mnq` for the historical Sierra builder. It defaults to
30 minutes for queue, grid and EMA strategies. Quote-only runs support up to 60 minutes.
The selected Sierra chart bar period controls its display independently of this window.

```powershell
python tools/sierra/session.py --source quotes --date 2026-10-23 --start 13:30 --minutes 30 --strategy queue --name mnq_20261023_1330_quotes_queue_30min --data-folder "D:/Market Project - Testing/SierraChart/Data"
```

Choose a symbol, date and time covered by your local archive. `--start` uses UTC.
Native `--source depth` requires matching depth files and a valid starting snapshot.
Open `/?session=mnq_20261023_1330_quotes_queue_30min` after generation completes.

`python tools/hbr.py data/recordings/<name>.hbr moments` lists replay moments in
a local recording and requires the NumPy dependency.

## Dashboard

Run `npm.cmd run dev` from `dashboard/` and open `http://127.0.0.1:5180`.
Generated sessions are served by the development middleware when added after startup.
Vite preview serves the built frontend and does not provide historical-builder APIs.

URL parameters

| parameter | meaning |
| --- | --- |
| `live=mnq` | Live MNQ market-data dashboard and engine paper simulation on Test. |
| `live=mnq&account=sierra` | Sierra simulated-account view on Test. |
| `sierra=mnq` | Historical Sierra MNQ builder on Test. |
| `session=<name>` | Named local replay. Without a name, the loader tries the configured/latest session and then a local sample if available. |
| `layout=landscape\|portrait` | Replay panel grid or vertical stack. |
| `panels=book:3,queue:2` | Panels and relative heights in portrait layout. |
| `panel=<key>` | Focus `book`, `queue`, `latency`, `fills`, `market`, `tape`, `log`, `engine`, `collector` or `week`. |
| `zoom=1\|2\|3` | Bitmap-font zoom. |
| `safe=0.16` | Space reserved above and below portrait panels. |
| `frame=1080x1920` | Fixed replay display dimensions. |
| `t=<sec>` `speed=<x>` `play=0\|1` | Replay start time, speed and autoplay. |
| `ladder=levels\|ticks` | Populated levels or every tick in the order-book ladder. |
| `keys=0` | Hide the replay key bar. |

Replay keys include `SPACE` for play/pause, `Left/Right` to seek five seconds,
`Shift+Left/Right` to seek 30 seconds, `Up/Down` for speed, `1`–`9` for panel focus,
`0` for all panels, `L` for layout, `B` for the ladder, `R` to restart and `H` for
the key bar. Replay settings are reflected in the URL.

The live view provides paper strategy controls, journaling, daily performance and
an emergency stop. Paper order authorization and configurable risk settings are
described in the kill-switch guide linked above.

The GitHub setup passed all 174 dashboard tests, the TypeScript checks and the Vite
build. The Sierra format suite passed 14 tests and skipped one requiring a built Rust
runner. GitHub-hosted Windows checks passed for the imported testing source.
Fresh Rust compilation and active Sierra/broker execution remain outside that verification.

```powershell
cd dashboard
npm.cmd run test:mnq
npm.cmd run build
cd ..
py -3.14 -m unittest discover -s tools/sierra -p test_session.py
```

GitHub Actions uses a hosted Windows runner with synthetic data and paper execution.
A push runs checks. Updating the installed Windows engine is a separate operation.

For recording views, use a locally generated session with the URL's layout, panel,
zoom and time settings. `tools/hbr.py` inspects recording statistics and replay moments.
`dashboard/shot.mjs` provides the existing Playwright screenshot utility after its
browser dependency is installed.

## Fonts

The Ultimate Oldschool PC Font Pack by VileR supplies `WebPlus_IBM_VGA_9x16` and
`WebPlus_IBM_EGA_8x8` under CC BY-SA 4.0.

- Departure Mono by Helena Zhang is distributed under SIL OFL. Font license files
  are retained in `dashboard/public/fonts/`.

Copyright (c) 2026 Darwin R. for Windows engine contributions.

The project includes upstream MIT-licensed source by Antonije Mirkovic and
nkaz001/hftbacktest. Their notices are retained in the applicable license files.
