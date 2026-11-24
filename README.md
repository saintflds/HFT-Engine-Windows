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

1. **Fees.** The MNQ historical converter defaults to $0.75 per contract per side.
   The sampled-feed paper simulator also uses $0.75 per contract per side. One
   entry and one exit therefore incur $1.50 in modeled fees for one contract.
   The historical converter accepts `--fee-per-contract` to change its assumption.
   These values are engine settings. Use your actual commission and exchange-fee
   schedule when evaluating a historical run.
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

MNQ and NQ contract values provide the units for prices, fills and P&L.

| Contract | Dollar value per index point | Minimum outright price increment | Dollar value of one tick per contract |
| --- | --- | --- | --- |
| Micro E-mini Nasdaq-100 (`MNQ`) | $2.00 | 0.25 index points | $0.50 |
| E-mini Nasdaq-100 (`NQ`) | $20.00 | 0.25 index points | $5.00 |

These contract specifications were checked against CME's contract descriptions.
Sources are [CME MNQ](https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.settlements.html)
and [CME NQ](https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html).

For an illustrative one-contract long entry at 25,000.00 and exit at 25,001.00,
the one-point move is four ticks. Gross P&L is $2.00 for MNQ and $20.00 for NQ.
With the engine's $0.75-per-side MNQ fee assumption, the MNQ example has $0.50 net
P&L before slippage. These prices illustrate the calculation and are separate
from recorded engine results and current market prices.

For one MNQ contract, the $1.50 modeled round-trip fee equals three ticks.
If a model additionally charges one tick of adverse slippage at both entry and
exit, those two ticks cost another $1.00. Combined friction in that example is
$2.50, or five MNQ ticks. The standalone bar-based EMA model exposes a slippage
setting and moves its simulated entry and exit prices accordingly.

The Windows converter and bar-based model currently use MNQ's $2 point value.
The paper simulator accepts `MNQZ26-CME` and its optional `[M]` suffix with a
0.25 tick size. NQ values in this table provide contract context. NQ execution,
other MNQ expiries in the paper path, and contract rollover need dedicated
configuration and verification. The generic Rust runner exposes a contract-size
argument, while the Windows Sierra converter supplies MNQ settings explicitly.

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
| Replay provenance | Companion metadata records the source, instrument and conversion assumptions used to produce each local session. |
| Paper risk controls | Shared server kill switch, exposure checks, configured loss/disconnection triggers and authorization at the simulated routing boundary. |
| Journaling and learning | Local journals, adaptive outcomes, training examples and predictor qualification checks. Predictor use depends on qualification and compatible inputs. |
| Daily performance | Saved paper journals and recorded replay accounting, subject to costs, coverage and replay-time rules. |

The historical Sierra builder supplies a `RiskAdverseQueueModel`, one-contract
order quantity, one-contract maximum position, a 0.25 tick size and a $2 point
value. Its default entry and response delays are 10,000 microseconds each
(10 ms entry plus 10 ms response). The paper simulator also defaults to 10 ms
entry and response delays. These are simulation assumptions and require separate
measurement before comparison with a live broker execution path.

Quote-only replay reconstructs saved best bid and ask with one assumed contract
at each price. Native depth replay reconstructs the initial book and applies
recorded depth updates. Both paths validate their inputs, while their available
observations determine what can be modeled. The standalone EMA lab operates on
minute bars, uses completed-bar signals and next-observed-open execution, applies
its configured costs, and handles gaps and session boundaries.

The live paper engine processes source-time prints, deduplicates overlapping tape,
tracks exchange-effective and acknowledged state, and models delayed responses.
Its synthetic tests cover cancellation/fill races, pending exposure and late
responses. A stale or interrupted feed suspends new routing. Source transitions
and replay rewinds also require simulation-state handling.

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
verified with Python 3.15.1 on Windows x64. The standard-library Sierra converter can
prepare historical inputs independently of NumPy. Full replay generation additionally
needs the built Rust runner at `runner/target/release/hftengine-runner.exe`.

```powershell
# Optional local environment for recording inspection
powershell -NoProfile -File tools/setup-sierra-python.ps1
.venv/Scripts/python.exe tools/hbr.py data/recordings/mnq_20261023_1330_depth_queue_30min.hbr
```

The filename is an example of a session you generate locally. A source clone
contains the tooling and tests, and requires local recordings for replay.

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

The expected local recording layout for the example MNQ contract is shown below.
Use the Sierra symbol and contract month that match your own archive.

```
SierraChart/Data/
  MNQZ26-CME.scid
  MarketDepthData/
    MNQZ26-CME.2026-10-23.depth

HFT-Engine-Windows/data/
  sierra/latest.json
  npz/
  recordings/
  kill-switch/
```

The `.scid` file supplies native tick records. The `.depth` file supplies the
matching day's order-book updates. Quote-only conversion uses saved best quotes
from the tick file. Native depth conversion requires suitable depth coverage and
a usable starting snapshot for the selected time window.

The publisher supplies chart symbol, connection and replay state, tick size,
depth, prints and selected simulated-account information. The browser receives
publications through the local server's stream. The publisher's source disables
trade-service order sending. Compiling that source and observing its output in an
active Sierra instance are distinct verification steps.

The repository retains the original public-stream collector utilities as a
separate workflow. The Windows examples here use MNQ recordings through Sierra.
Keep tick archives, recordings, local account files and licensed market data on
the Windows machine. The source repository's ignore rules exclude these inputs.

## Build a session and replay it

Use an authorized local MNQ archive and a built historical runner. The following
example uses October 23, 2026 at 13:30 UTC for 30 minutes. Choose a window actually
covered by your own files. It is an explicit historical time and does not adjust
automatically to the current date or a market session's daylight-saving rules.

```powershell
python tools/sierra/session.py --source depth --symbol MNQZ26-CME --date 2026-10-23 --start 13:30 --minutes 30 --strategy queue --fee-per-contract 0.75 --latency-us 10000,10000 --name mnq_20261023_1330_depth_queue_30min --data-folder "D:/Market Project - Testing/SierraChart/Data"
cd dashboard
npm.cmd run dev
```

After generation completes, open
`http://127.0.0.1:5180/?session=mnq_20261023_1330_depth_queue_30min`.
The historical converter validates file format and coverage, prepares normalized
events, runs the Rust strategy, records frames and stages the replay outputs.

| session | content |
| --- | --- |
| `mnq_20261023_1330_depth_queue_30min` | Example native-depth queue replay using the selected SCID and depth files. |
| `mnq_20261023_1330_quotes_queue_30min` | Example quote-only queue replay, with one assumed contract at each saved best bid and ask. |
| MNQ grid or EMA replay | Change `--strategy` to `grid` or `ema` and give the output a distinct session name. |

On `Test`, open `/?sierra=mnq` for the historical Sierra builder. It defaults to
30 minutes for queue, grid and EMA strategies. Quote-only runs support up to
60 minutes. EMA conversion requires at least 22 minutes because its initial
21 completed minute bars warm up the averages. The Sierra chart bar period
controls chart display independently of the requested replay window.

```powershell
# Quote-only historical replay
python tools/sierra/session.py --source quotes --symbol MNQZ26-CME --date 2026-10-23 --start 13:30 --minutes 30 --strategy queue --name mnq_20261023_1330_quotes_queue_30min --data-folder "D:/Market Project - Testing/SierraChart/Data"

# Validate and prepare the same quote input without launching the Rust runner
python tools/sierra/session.py --prepare-only --source quotes --symbol MNQZ26-CME --date 2026-10-23 --start 13:30 --minutes 30 --strategy queue --name mnq_20261023_1330_quotes_prepared --data-folder "D:/Market Project - Testing/SierraChart/Data"
```

| Builder option | Meaning |
| --- | --- |
| `--source depth` | Native recorded-depth reconstruction with matching tick and depth inputs. |
| `--source quotes` | Best-quote reconstruction from the selected tick file. |
| `--date`, `--start`, `--minutes` | Historical date, UTC start time and replay duration. |
| `--symbol` | MNQ contract symbol matching the archive, such as `MNQZ26-CME`. |
| `--strategy` | `queue`, `grid` or `ema`. |
| `--fee-per-contract` | USD per contract per side. Default is $0.75. |
| `--latency-us` | Entry and response delays in whole microseconds. Default is `10000,10000`. |
| `--data-folder` | Local Sierra archive directory. |
| `--trade-file`, `--depth-file` | Explicit input file paths when the archive uses a different layout. |
| `--name` | Distinct session identifier for generated outputs. |
| `--prepare-only` | Validate and write normalized input and provenance without invoking the runner. |

Prepared events are saved under `data/npz/`. The HBR recording is saved under
`data/recordings/`, and generated replay assets are staged in
`dashboard/public/sessions/`. Companion Sierra metadata describes the conversion
and its source assumptions. Earlier provenance paths describe the machine that
produced a recording. Select current input locations explicitly when moving copies.

```powershell
.venv/Scripts/python.exe tools/hbr.py data/recordings/mnq_20261023_1330_depth_queue_30min.hbr
.venv/Scripts/python.exe tools/hbr.py data/recordings/mnq_20261023_1330_depth_queue_30min.hbr moments
```

The inspection utility requires NumPy. Replay counts are evaluated at the current
playhead, so an intermediate fill or cancellation count can differ from the full
session total. Terminal accounting and source metadata should be checked together
when reviewing a run.

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
an emergency stop. The server's paper controller enforces its shared stop at the
simulated routing boundary across dashboard sessions. It tracks cancellation
outcomes, audits session retirement and reconciles failed cancellations when a
local simulated session is retired.

| Paper risk setting | Current behavior |
| --- | --- |
| `HFTENGINE_KILL_RESET_TOKEN` | Operator-provided reset credential of at least 24 characters. Missing configuration denies reset. Keep the value in the local server environment. |
| `HFTENGINE_KILL_MAX_LOSS_USD` | Optional positive USD loss limit for individual paper-session marked equity, including recorded fees. Reaching it trips the shared stop. |
| `HFTENGINE_KILL_ON_DISCONNECT` | Set to `1` to latch a stop after a previously fresh feed disconnects, goes stale or becomes invalid. The default `0` suspends routing during interruption and permits recovery when feed and authorization conditions are met. |

An active stop is persisted in `data/kill-switch/state.json`, and transition events
are appended to `data/kill-switch/audit.jsonl`. Missing, unreadable or invalid state
starts blocked. Each server restart requires fresh paper authorization. Reset also
requires valid state and reconciliation of cancellation failures. The detailed
operator flow is documented in the kill-switch guide linked above.

Journaling records simulated fills, closed trades, sampled market observations and
strategy summaries. Retry handling and linked segments support recovery from
interrupted writes. The learning components collect eligible examples, use
chronological splits and require qualification before using a compatible predictor.
Daily performance derives results from recorded journals or replay accounting and
reports available coverage. The task register records outstanding gaps in these paths.

The GitHub setup passed all 174 dashboard tests, the TypeScript checks and the Vite
build. The Sierra format suite passed 14 tests and skipped one requiring a built Rust
runner. GitHub-hosted Windows checks passed for the imported testing source.
Coverage includes source-time replay, MNQ contract accounting, overlapping tape,
fill/cancel races, exposure limits, journal retry/recovery, model qualification,
historical cutoffs and daily performance calculations. Dedicated kill-switch tests
exercise authorization, activation, persistence, cancellation failures, session
retirement, invalid feeds and delayed requests.

Fresh Rust compilation and active Sierra/broker execution remain outside that
verification. Test totals describe the source import checks recorded during setup.
Check the repository's current Actions run for the result of a newer commit.

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
