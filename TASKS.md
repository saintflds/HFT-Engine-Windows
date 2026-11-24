# Windows HFT task register

This register records work already present in the private repository's Test branch.
It draws on the Windows action audit dated November 21, 2026 and the source import
and offline checks completed during the GitHub setup on November 23, 2026.

## Original project tasks

| Project task | Current recorded status | Evidence and remaining scope |
| --- | --- | --- |
| #34 — Emergency kill switch | Implemented and tested for Windows paper execution | [Implementation and verification](docs/emergency-kill-switch.md), [controller](dashboard/server/kill-switch.mjs), [paper order boundary](dashboard/server/paper-execution.mjs), and [dedicated tests](dashboard/tests/kill-switch.test.mjs). Included in the 174 dashboard tests passed during the GitHub setup. Live broker integration remains pending. |
| #37 — Risk controls after reconnection | Next unfinished task identified in the original discussion | Reconnection and feed interruption already have some synthetic coverage. The broader original task has no completion evidence in the available register. |

The complete original 60-task list was unavailable. The audit item numbers below
identify inspected capabilities and have their own numbering. Use the project task
numbers in the table above when requesting work on Task #34 or Task #37.

## Verification during GitHub setup

- The Test source was imported from the existing Windows testing checkout.
- All 174 dashboard tests passed, including the dedicated kill-switch suite.
- The Sierra file-format suite passed 14 tests and skipped one requiring a built Rust runner.
- TypeScript, the dashboard production build and Python syntax checks passed.
- GitHub-hosted Windows checks passed for the imported testing source. Runs are visible in [Actions](https://github.com/saintflds/HFT-Engine-Windows/actions).
- Fresh Rust compilation and execution through an active Sierra Chart instance remain unverified in this setup.
- Automated checks use synthetic inputs and paper execution.

## Capability audit recorded on November 21

The following 81 entries preserve the prior audit's descriptions, statuses and
scope limits. Their evidence predates the GitHub import. These rows record
inspected capabilities and prior test results, rather than attribution of every
feature to work performed in this chat.

A Tested status covers the assertions described in that row. Untested means
implementation was found but the listed behavior lacked a direct test.
Incomplete identifies a missing capability or recorded gap.

Evidence paths resolve from the original Windows testing engine. Paths beginning
with ../ refer to launcher files outside the engine repository. Those launchers
and historical data were outside the GitHub source import.

### Desktop startup, replay and dashboard

| Audit item | Work recorded | Prior status | Recorded evidence |
| --- | --- | --- | --- |
| 1 | Resolve Live, Replay and Backtest desktop shortcuts to distinct routes | Tested | `../Live Engine.vbs`, `../Replay Engine.vbs`, `../Backtest Engine.vbs`, `../Support/Launcher/open.vbs`, `../Support/Launcher/launch.cjs`. Route and browser argument assertions in `../Support/Launcher/launch.test.cjs`. |
| 2 | Locate/start the installed local server, check project identity and open the browser app window | Untested | `../Support/Launcher/launch.cjs`. Arguments and server identity response have unit coverage. Actual desktop startup, browser discovery and handling a busy port were outside the fixture run. |
| 3 | Serve dashboard assets, project identity and replay files added after startup | Tested | `../Support/Launcher/desktop-server.mjs`, `dashboard/server/sessions.mjs`, `dashboard/vite.config.ts`. `../Support/Launcher/desktop-server.test.mjs`, `dashboard/tests/sessions.test.mjs`. |
| 4 | Open sample replay, Live MNQ, Sierra Account, historical builder and standalone MNQ lab | Tested | `dashboard/src/main.ts`, `dashboard/src/original-live.ts`, `dashboard/src/mnq/main.ts`. Isolated browser smoke. |
| 5 | Auto-select the most recently staged recording and fall back to the sample | Untested | `dashboard/src/main.ts`, `tools/session.py`, `tools/sierra/session.py`. Explicit sample loading passed; default selection and fallback were source-reviewed. |
| 6 | Download and parse HBR frames and arrays, validate header, shape and range | Tested | `dashboard/src/hbr.ts`, `dashboard/src/session.ts`. Actual bundled sample opened in the browser; malformed format cases passed in `dashboard/tests/stability.test.mjs`. |
| 7 | Show download progress and read optional collector/Sierra provenance files | Untested | `dashboard/src/main.ts`, `dashboard/src/hbr.ts`, `dashboard/src/panels/collector.ts`. Sample loaded; progress transitions and metadata rendering were outside the assertions. |
| 8 | Load bitmap fonts and render the main replay panels | Tested | `dashboard/src/style.css`, `dashboard/public/fonts/`, `dashboard/src/main.ts`, `dashboard/src/panels/`. Browser loaded the font and rendered nine or more panels. Individual chart interactions are covered only where listed. |
| 9 | Play, seek, restart, change layout and focus a panel | Tested | `dashboard/src/main.ts`, `dashboard/src/clock.ts`. Browser checked play, seek, restart, layout and focus; frame selection also passed in `dashboard/tests/stability.test.mjs`. |
| 10 | Pause and configure replay speed, key bar, ladder mode, zoom, safe areas, frame size and custom panel sets | Untested | `dashboard/src/main.ts`, `dashboard/src/clock.ts`, `dashboard/src/panels/book.ts`, `dashboard/src/style.css`. |
| 11 | Generate observed candles, volume, delta and VWAP without looking ahead | Tested | `dashboard/src/candles.ts`, `dashboard/src/chart-stats.ts`, `dashboard/src/market-chart.ts`. `dashboard/tests/live-session.test.mjs`. |
| 12 | Enable chart overlays, marker hover and panel-level detail interactions | Untested | `dashboard/src/market-chart.ts`, `dashboard/src/panels/market.ts`, `dashboard/src/sierra-chart-overlay.ts`, `dashboard/src/sierra-panels.ts`. Test coverage applies to input/model data and the panel shell. |
| 13 | Include terminal simulated acknowledgments/fills in replay at their proper time | Tested | `dashboard/src/session.ts`, `runner/src/main.rs`. `dashboard/tests/terminal-replay.test.mjs` verifies end-of-replay and rewind visibility. |

### Sierra bridge and live-data path

| Audit item | Work recorded | Prior status | Recorded evidence |
| --- | --- | --- | --- |
| 14 | Compile the native Windows Sierra publisher | Tested | `tools/sierra/build.cmd`, `tools/sierra/HFTEngineLive.cpp`. Fresh x64 DLL builds with each project's `../SierraChart/ACS_Source/sierrachart.h` passed. Build outputs stayed in fixtures. |
| 15 | Run the Sierra study on chart updates with trade-service sending disabled | Untested | `tools/sierra/HFTEngineLive.cpp:78`. Defaults and update path set `sc.SendOrdersToTradeService = false`; the DLL was compiled and never loaded in Sierra during this audit. |
| 16 | Read Sierra symbol, connection and replay state, chart cadence, delay, tick size and last price | Untested | `tools/sierra/HFTEngineLive.cpp:104`. Native reads inspected and compiled; active Sierra reads unverified. |
| 17 | Read bid/ask market depth and trade prints, including sequence, time, price, quantity and side | Untested | `tools/sierra/HFTEngineLive.cpp:119`. Native reads inspected and compiled; actual chart publications unverified. |
| 18 | Read the selected Sierra simulated position, average price and P&L | Untested | `tools/sierra/HFTEngineLive.cpp:32`. Native read unverified. |
| 19 | Read and filter Sierra simulated orders and their status/role | Untested | `tools/sierra/HFTEngineLive.cpp:41`. Native read unverified. |
| 20 | Read Sierra simulated executions separately from engine paper fills | Untested | `tools/sierra/HFTEngineLive.cpp:61`, `dashboard/src/sierra-account.ts`. Native fill capture unverified. |
| 21 | Publish Sierra snapshots via temporary file plus atomic replacement | Untested | `tools/sierra/HFTEngineLive.cpp:153`. Native writer compiled; the server received a file replaced by a synthetic producer. |
| 22 | Watch the JSON file and push updated frames over SSE | Tested | `dashboard/server/live-stream.mjs`. `dashboard/tests/live-stream.test.mjs` replaced a temporary JSON file and received both frame versions over loopback SSE. |
| 23 | Retry transient snapshot races with heartbeat and manage stream lifecycle | Untested | `dashboard/server/live-stream.mjs`. Basic push passed; deliberate file races, heartbeat fallback and real reconnect were outside the assertions. |
| 24 | Validate incoming browser frames and normalize book quantities and tape | Tested | `dashboard/src/live-session.ts`, `dashboard/src/original-live-tape.ts`. `dashboard/tests/live-session.test.mjs`, `dashboard/tests/original-live-tape.test.mjs`. |
| 25 | Freeze paper simulation on interruption, clear unsafe quotes and reseed on return | Tested | `dashboard/src/live-dashboard.ts`, `dashboard/src/replay-simulation.ts`. Synthetic interruption, retained accounting and reseed tests in `dashboard/tests/live-session.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs` and `dashboard/tests/stability.test.mjs`. |
| 26 | Show waiting, stale, disconnected and replay status, and reconnect from a real stream interruption | Untested | `dashboard/src/live-dashboard.ts`, `dashboard/server/live-stream.mjs`. Browser smoke opened the waiting shell; all live status transitions were outside the browser fixture. |
| 27 | Open the Sierra account panel and switch shared panels between Sierra and engine data | Tested | `dashboard/src/live-dashboard.ts`, `dashboard/src/sierra-account-view.ts`. Browser checked source switch. |
| 28 | Validate and display populated Sierra Sim account rows, contract filtering, P&L and chart fill markers | Untested | `dashboard/src/sierra-account.ts`, `dashboard/src/sierra-account-view.ts`, `dashboard/src/sierra-panels.ts`, `dashboard/src/sierra-chart-overlay.ts`. The account shell and switch passed; live Sierra rows and markers were outside the assertions. |
| 29 | Run the complete Sierra → Windows dashboard path against an active publishing chart | Untested | `tools/sierra/HFTEngineLive.cpp`, `dashboard/server/project-paths.mjs`, `dashboard/server/live-stream.mjs`, `dashboard/src/live-dashboard.ts`. Layer tests used fixture data. |

### Paper simulator and risk controls

| Audit item | Work recorded | Prior status | Recorded evidence |
| --- | --- | --- | --- |
| 30 | Set strategy, number of queues, learning, local reset and enabled state | Tested | `dashboard/src/live-dashboard.ts`, `dashboard/src/replay-simulation.ts`. Browser checked selections, learning and reset; enable/off and reset behavior passed in `dashboard/tests/replay-simulation.test.mjs`. |
| 31 | Restrict the paper simulator to supported MNQ contract/tick and explicit live mode | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`. |
| 32 | Reset simulation generation for rewind, source/mode transitions and explicit reset | Tested | `dashboard/src/replay-simulation.ts`, `dashboard/src/original-live-tape.ts`. `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/original-live-tape.test.mjs`. |
| 33 | Deduplicate overlapping prints and cap retained tape | Tested | `dashboard/src/original-live-tape.ts`, `dashboard/src/replay-simulation.ts`. `dashboard/tests/original-live-tape.test.mjs`. |
| 34 | Seed new quotes after old prints and prevent duplicate/wall-clock-only publications from filling | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/live-session.test.mjs`. |
| 35 | Detect missing overlap and discard uncertain orders without inventing fills | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`. |
| 36 | Process prints in source time and deliver order responses chronologically across sparse updates | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 37 | Retain a rolling print window, calculate flow and warm up at high tape rates | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/busy-tape.test.mjs`, `dashboard/tests/adaptive-engine.test.mjs`. |
| 38 | Calculate depth imbalance, momentum, range, spread and stable-level lifetime | Untested | `dashboard/src/replay-simulation.ts:607`, `dashboard/src/replay-simulation.ts:723`. Integrated strategy tests exercised signal gates; each calculation and threshold boundary lacks a direct assertion in the reviewed tests. |
| 39 | Apply liquidity entry gates and wait for aligned signals | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/adaptive-engine.test.mjs` checks warmup and aligned pressure; `dashboard/tests/replay-simulation.test.mjs` checks missing eligible depth. |
| 40 | Rank observed demand/supply and exit levels, space quotes and respect configured queue counts | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs` checks multi-level observed quotes outside the fee buffer and observed exit targets. Ranking tie-breaks lack a direct assertion. |
| 41 | Place paper quotes at best bid/ask in queue mode | Tested | `dashboard/src/replay-simulation.ts`. Seed and queue fill cases in `dashboard/tests/replay-simulation.test.mjs`. |
| 42 | Create modeled orders and record side, price, quantity, queue and execution reason | Tested | `dashboard/src/replay-simulation.ts`. Order and fill reason cases in `dashboard/tests/replay-simulation.test.mjs`. |
| 43 | Model entry, acknowledgment, fill and cancellation delays | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/adaptive-engine.test.mjs`, `dashboard/tests/execution-races-20261107.test.mjs`. |
| 44 | Keep exchange-effective state and locally acknowledged order/account state separate | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 45 | Consume eligible prints against queue ahead once and enforce price eligibility | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/execution-races-20261107.test.mjs`. |
| 46 | Request cancellation, wait for cancellation receipt before slot reuse, and resolve fill/cancel races | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/execution-races-20261107.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 47 | Enforce maximum simulated position, including working orders and in-flight fills | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 48 | Trigger target, adverse stop and hold-time exits and model market-style slippage | Tested | `dashboard/src/replay-simulation.ts`. Long and short protective scenarios in `dashboard/tests/replay-simulation.test.mjs`. |
| 49 | Update position, average entry, cash, realized/unrealized P&L and per-side fees | Tested | `dashboard/src/replay-simulation.ts`. MNQ round trips and local fill receipt in `dashboard/tests/replay-simulation.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 50 | Record closed-trade reason, net result, and adverse/favorable excursion | Tested | `dashboard/src/replay-simulation.ts`, `dashboard/src/engine-journal.ts`. Round-trip net and reasons are tested in `dashboard/tests/adaptive-engine.test.mjs`; excursion values lack a direct assertion. |
| 51 | Tighten or relax adaptive entry risk after enough closed trades | Tested | `dashboard/src/replay-simulation.ts`. `dashboard/tests/adaptive-engine.test.mjs` checks the 20-trade threshold and bounded adjustments. |
| 52 | Capture and bound paper snapshots, orders, fills, logs and dashboard buffers | Tested | `dashboard/src/replay-simulation.ts`, `dashboard/src/live-session.ts`. `dashboard/tests/stability.test.mjs` exercises 2,500 updates; `dashboard/tests/live-session.test.mjs` checks replay-panel data. |
| 53 | Capture detailed gate/decision diagnostics in journal records | Untested | `dashboard/src/replay-simulation.ts:672`, `dashboard/src/engine-journal.ts:38`. Journal persistence and strategy decisions are tested; detailed gate payload assertions were outside the reviewed tests. |

### Journaling, learning and performance

| Audit item | Work recorded | Prior status | Recorded evidence |
| --- | --- | --- | --- |
| 54 | Collect trades, sampled depth, events, fills, closed trades and strategy summaries into journal batches | Tested | `dashboard/src/engine-journal.ts`, `dashboard/server/journal.mjs`. `dashboard/tests/journal-recovery-20261108.test.mjs`, `dashboard/tests/adaptive-engine.test.mjs`. |
| 55 | Preserve pending batches across retries, identity changes and transient write failures | Tested | `dashboard/src/engine-journal.ts`, `dashboard/server/journal.mjs`, `dashboard/server/jsonl.mjs`. `dashboard/tests/journal-recovery-20261108.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 56 | Validate journal identity and sequence, recover torn writes and roll into linked segments | Tested | `dashboard/server/journal.mjs`, `dashboard/server/jsonl.mjs`. `dashboard/tests/adaptive-engine.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 57 | Restore compatible live adaptive outcomes while excluding replay and older execution versions | Tested | `dashboard/server/journal.mjs`, `dashboard/src/replay-simulation.ts`. `dashboard/tests/adaptive-engine.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 58 | Collect and label eligible training examples, split chronologically, train/evaluate and reject unqualified models | Tested | `dashboard/server/deep-store.mjs`, `dashboard/server/deep-network.mjs`, `dashboard/server/deep-worker.mjs`. `dashboard/tests/deep-learning.test.mjs`, `dashboard/tests/independent-fixes-20261108.test.mjs`. |
| 59 | Apply a qualified predictor only in valid source-time/symbol conditions and protect existing exits | Tested | `dashboard/src/deep-model.ts`, `dashboard/src/replay-simulation.ts`. `dashboard/tests/deep-integration.test.mjs`. The installed Testing model in `Engine History/Deep Learning/model.json` has `qualified: false`; actual live inference is inactive. |
| 60 | Publish current deep-model state and use it end to end in a running dashboard | Untested | `dashboard/server/journal.mjs`, `dashboard/src/deep-model.ts`, `dashboard/src/live-dashboard.ts`. Training and inference components passed fixture tests; no qualifying installed predictor was exercised. |
| 61 | Calculate daily closed-trade results from saved paper journals with costs, overlap and coverage rules | Tested | `dashboard/server/daily-performance.mjs`. `dashboard/tests/daily-performance.test.mjs` covers run selection, duplicate writes, fees, cutoff, partial days, retention limits and GET endpoint. |
| 62 | Calculate historical replay daily outcomes from visible fills or valid marked accounts | Tested | `dashboard/src/performance-data.ts`. `dashboard/tests/performance-data.test.mjs` covers FIFO, fees, partial fills, reversals, absent results and rewind. |
| 63 | Display the daily performance calendar and navigate between years | Tested | `dashboard/src/performance-grid.ts`. Testing browser smoke checked date-cell rendering and year control. |
| 64 | Browse populated daily details, per-run selectors and partial coverage in the calendar UI | Untested | `dashboard/src/performance-grid.ts`, `dashboard/server/daily-performance.mjs`. Data calculations passed; browser checks used empty history. |
| 65 | Recover paper processing from a permanently rejected pending journal write | Incomplete | `dashboard/src/live-dashboard.ts:178` requires journal retry success before accepting a frame. `dashboard/src/engine-journal.ts:16` retains failed batches except for specifically handled cases. `dashboard/server/journal.mjs:93` has an origin check. Transient retry tests passed. A permanent origin rejection can keep the engine waiting until the underlying condition changes. This was identified by source review. |

### Historical runs, data utilities and unavailable order paths

| Audit item | Work recorded | Prior status | Recorded evidence |
| --- | --- | --- | --- |
| 66 | Parse Sierra SCID trades and quotes, build minute bars and exclude out-of-day data | Tested | `dashboard/server/sierra.mjs`. `dashboard/tests/mnq.test.mjs`, `dashboard/tests/week-alignment-20261108.test.mjs`. |
| 67 | Supply weekly history and limit historical bars/trades to the replay playhead | Tested | `dashboard/server/sierra.mjs`, `dashboard/src/panels/week.ts`. `dashboard/tests/week-alignment-20261108.test.mjs` validates cutoff, contract matching and day boundaries. The actual installed archive and weekly UI alignment were outside that test. |
| 68 | Scan archive coverage, validate requested dates and distinguish quotes from native depth | Tested | `dashboard/server/engine.mjs`, `dashboard/src/sierra-history.ts`, `tools/sierra/session.py`. Browser checked unavailable-data and EMA selection guards; `dashboard/tests/stability.test.mjs` checks polling/cache and unique session paths; Python format fixtures verify missing coverage. |
| 69 | Prepare native depth/tick input, reconstruct the starting book and order tied ticks | Tested | `tools/sierra/session.py`, `tools/sierra/test_session.py`. Synthetic SCID/depth tests cover incomplete snapshots, invalid batches and tied events. |
| 70 | Build quote-only history with one assumed contract per best bid/ask | Tested | `tools/sierra/session.py`, `tools/sierra/test_session.py`. Tests verify no look-ahead quotes, input limits and refusal of bad data. |
| 71 | Run native queue, grid and EMA strategies with configured fees, latency and sizing | Tested | `runner/src/main.rs`, `tools/sierra/session.py`. Each existing release executable ran all three strategies on synthetic data and emitted 17,409 replay frames per run. The existing Rust test executables cover fees and EMA warmup; Testing also covers pending orders and exposure. |
| 72 | Save HBR book, order, fill, timing, fee and summary data for replay | Tested | `runner/src/main.rs`, `runner/src/record.rs`, `dashboard/src/hbr.ts`. Python format suite, Rust executable smoke and sample-replay browser test. |
| 73 | Start a historical job through the user form, build from the installed Sierra archive and open that resulting session | Untested | `dashboard/src/sierra-history.ts`, `dashboard/server/engine.mjs`, `tools/sierra/session.py`. Fixture tests exercised those layers independently. No POST went to an installed engine and no real archive run was staged. |
| 74 | Run standalone bar-based MNQ EMA with next-open fills, session boundaries, costs and equity/drawdown | Tested | `dashboard/src/mnq/backtest.ts`, `dashboard/src/mnq/main.ts`. `dashboard/tests/mnq.test.mjs` covers behavior and assumptions; browser smoke opened the lab. |
| 75 | Play/seek standalone EMA bars, show results and export trades CSV | Untested | `dashboard/src/mnq/main.ts`. Browser test checked tab navigation, not a populated CSV/export flow. |
| 76 | Start, stop and report status of public Binance market-data collector | Untested | `tools/collect.py`, `hftbacktest/collector/`. No public collector process was started or stopped. |
| 77 | Recover raw gzip, convert Binance data, derive latency, compute collection facts and stage a replay | Untested | `tools/prepare.py`, `tools/session.py`. This pipeline is separate from tested Sierra format preparation. |
| 78 | Inspect HBR summaries and replay moments from Python, or take dashboard screenshots via CLI | Untested | `tools/hbr.py`, `dashboard/shot.mjs`, `dashboard/keys.mjs`. The app's HBR loader and browser rendering were tested through their usual browser entry points. |
| 79 | Submit, cancel, modify or flatten orders in Sierra Sim1 from the engine | Incomplete | `tools/sierra/HFTEngineLive.cpp` reads Sierra account state. `dashboard/src/replay-simulation.ts` models locally. No application action connects the order lifecycle to Sierra Sim1. |
| 80 | Submit, cancel, modify or flatten real broker or exchange orders, including Teton routing | Incomplete | No assembled route from the Windows app to Sierra trade services. `hftbacktest/connector/` is a submodule component; its presence does not establish an integration with `dashboard/` or the native backtest runner. |
| 81 | Broker acknowledgments, fills, positions, live P&L reconciliation, and end-to-end execution/latency validation | Incomplete | The integrated real routing/feedback path is absent. `tools/sierra/HFTEngineLive.cpp` and `dashboard/src/sierra-account.ts` expose simulated Sierra account state, and the local engines maintain their own models. |
