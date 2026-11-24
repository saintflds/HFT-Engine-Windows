# Task #34 — Emergency kill switch

The Windows dashboard’s paper strategies share a kill switch in the local engine server. Queue entries, liquidity orders, targets and protective market-style orders all pass through the gate before reaching the simulated exchange. The Sierra adapter supplies connected, fresh market data to the server. A disconnected, stale or invalid feed blocks routing independently of the switch. The Rust historical runner and the Sierra account display are independent of the paper execution path.

## Authorize or stop paper routing

Set the following environment variables for the local dashboard server process before starting it. The Windows launcher inherits its environment when it starts a new server. The desktop server and dashboard build were verified with Node 24.22.1.

| Setting | Behavior |
| --- | --- |
| **HFTENGINE_KILL_RESET_TOKEN** | Operator-held reset credential, at least 24 characters. Set a high-entropy value. Without it, the server denies resets. |
| **HFTENGINE_KILL_MAX_LOSS_USD** | Optional positive USD limit for the marked equity loss of an individual paper session, including recorded fees. Reaching the limit trips the shared switch. |
| **HFTENGINE_KILL_ON_DISCONNECT** | Set to **1** to latch the switch after a previously fresh Sierra feed disconnects, becomes stale, or returns invalid or unreadable data. Closing the last dashboard listener alone does not latch the switch. The default, **0**, freezes orders during the interruption and permits automatic recovery when the feed is fresh and paper routing is authorized. |

The engine always trips on invalid simulated accounting or exposure beyond its existing hard position limit. Invalid risk configuration keeps routing blocked.

In **Live MNQ** or **Sierra Account**, click **Emergency stop** to block all dashboard paper sessions and cancel outstanding simulated orders. While the switch is active, fresh data for the same source can advance acknowledgments and accounting for already executed paper fills. The simulator skips print matching and strategy evaluation and retains open paper positions.

To permit paper routing, click **Authorize paper orders**, enter the configured reset token and confirm. Authorization applies to the current server process. Missing or invalid state starts blocked, and each restart requires fresh authorization. An active stop restores its original reason and ID after restart. New order routing requires a fresh Sierra publication observed after authorization. A paper request already in flight across the stop and reset cannot place orders under the new authorization. If any cancellation fails, the switch retains the failure and rejects reset. **Emergency stop** retries outstanding cancellations. Repeated automatic risk checks leave retries to the operator.

Closing or evicting a paper session attempts and audits cancellation before permanently retiring its local simulated exchange. Retirement disposes of that session's orders and queued responses. The controller then reconciles any remaining cancellation failures for that session and records those failures in the retirement audit. A late request for a closed session cannot recreate it with a pre-close publication.

## Audit

The checkout stores state in **data/kill-switch/state.json** and appends events to **data/kill-switch/audit.jsonl**. Audit events include UTC time, server boot ID, switch ID, manual or automatic activation reason, paper session and order IDs for cancellations, failures, and reset outcomes. If a required write fails, the server blocks routing and reports the failure. Audit write failures also go to server stderr. Startup reads only **state.json**. Temporary files left by interrupted writes have no effect on authorization.

## Verification

- 22 dedicated kill-switch tests passed. The combined dashboard and Windows launcher suite passed all 178 tests. New cases cover closure with a failed cancellation, delayed HTTP requests, invalid feeds, and interrupted state writes.
- TypeScript and the Vite production build passed in a temporary fixture. Headless Chrome exercised startup blocking, token rejection, authorization, strategy routing, the Sierra snapshot stream and emergency cancellation against synthetic data.
- One fixture regression run omitted an existing relative test dependency (**dashboard/verify-project.mjs**). The rerun with that file passed.
- Active Sierra Chart, physical power-loss behavior and production throughput were outside testing. This checkout has no Sierra or broker execution adapter. No live orders, cancellations or position flattening were performed.
