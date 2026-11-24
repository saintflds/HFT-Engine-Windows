/** ENGINE: what is being replayed — data files, models, strategy parameters, run statistics, and
 * replay progress. Every value comes from the recording's metadata. */
import { bar, sp } from "../dom";
import { bytes, clock, lj, thousands } from "../fmt";
import type { Session } from "../session";
import { Panel, type RenderCtx } from "./base";

export class EnginePanel extends Panel {
  constructor(s: Session) {
    super("engine", 8, "ENGINE", s);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const f = c.f;
    const key = `${f}|${c.t >= s.endT}|${this.rows}|${this.cols}|${c.playing}|${c.speed}|${s.meta.live?.state ?? ''}|${s.meta.live?.message ?? ''}`;
    if (!this.changed(key)) return;
    const m = s.meta;
    const accounting = s.accountingAt(c.t);
    const cols = this.cols;
    const L = (k: string, v: string) => sp("d", lj(k, 10)) + v;
    const lines: string[] = [];
    if (m.live) {
      const sim = m.live.sim;
      const line = (label: string, value: string, cls = 'w') => L(label, sp(cls, value));
      const account=m.live.followSierra?m.live.sierraAccount:null;
      const deep=m.live.deep;
      const learningLines=deep?[line('DEEP NET',deep.status,'c'),line('EXAMPLES',deep.samples+' / '+deep.minimum+' minimum'),line('NETWORK','6 → 16 → 8 → 3'),line('FORECAST','10s up / flat / down'),line('EVALUATION',deep.evaluation?('Test '+(100*deep.evaluation.test.accuracy).toFixed(1)+'% / '+deep.evaluation.test.count+' samples'):'Waiting for enough data'),line('USE',deep.model?'Entry veto only / fixed risk':'Existing strategy; model not active')]:[];
      const refreshLines=[line('UPDATES','Pushed from Sierra'),line('CHART RATE',m.live.chartUpdateMs?m.live.chartUpdateMs+' ms':'Awaiting bridge update'),line('BRIDGE',m.live.bridgeIntervalMs?m.live.bridgeIntervalMs+' ms last interval':'—')];
      if(m.live.followSierra){
        this.body.innerHTML=[line('SOURCE','Sierra account records','c'),line('ACCOUNT',account?.account??'Unavailable'),line('POSITION',String(account?.position?.quantity??'—')),line('AVG PRICE',account?.position?.averagePrice?.toFixed(2)??'—'),line('OPEN P&L',account?.position?.openPnl?.toFixed(2)??'—'),line('DAILY P&L',account?.position?.dailyPnl?.toFixed(2)??'—'),line('FEES','Not exported by this feed'),line('EXECUTION','Sierra simulation account'),...refreshLines,'',...learningLines,line('HISTORY',m.live.historyStatus??'Connecting'),'','Deep model filters the separate engine simulation.','Sierra orders are read only.'].join('\n');this.setTitle('SIERRA ACCOUNT');return;
      }
      this.body.innerHTML = [
        line('ENGINE', sim.strategy === 'liquidity' ? (sim.strategyVersion==='liquidity-flow-v2'?'Liquidity + flow v2':'Liquidity zones') : 'Queue maker'),
        line('QUEUES', `${sim.levelsPerSide} per side / max pos 1`),
        line('STATE', m.live.state ?? 'WAITING', 'y'),
        line('POSITION', `${sim.position} contracts`),
        line('ORDERS', `${thousands(sim.submits)} submitted`),
        line('FILLS', `${thousands(sim.fillCount)} executions`, 'c'),
        line('CANCELS', thousands(sim.cancels)),
        line('NET P&L', `$${sim.equity.toFixed(2)}`, sim.equity >= 0 ? 'g' : 'r'),
        line('FEES', `$${sim.fees.toFixed(2)}`),
        line('SOURCE', 'Sierra depth + trades'),
        line('QUEUE', 'Estimated from sampled L2', 'y'),
        line('ORDER LAT', sim.latencyMode==='variable'?'Variable 4–60 ms / way':'10 / 10 ms assumed', 'y'),
        ...(sim.strategy === 'liquidity' ? [line('TARGET', `${sim.targetTicks} ticks`), line('STOP', `${sim.stopTicks} ticks / 60s hold`), line('DECISION', sim.decision, 'y')] : []),
        line('DATA GAPS', String(sim.dataGaps), sim.dataGaps ? 'r' : 'w'),
        ...(sim.signal ? [line('FLOW',`${(sim.signal.flow*100).toFixed(0)}% trade / ${(sim.signal.depth*100).toFixed(0)}% depth`),line('RANGE',`${sim.signal.rangeTicks.toFixed(0)} ticks / 20s`),line('COOLDOWN',`${sim.cooldownMs/1000}s`)] : []),
        ...(sim.learning ? [line('LEARNING',`${sim.learning.enabled?'ON':'OFF'} / filter level ${sim.learning.riskLevel}`),line('REVIEW',`${sim.learning.samples} trades / next in ${sim.learning.nextReview}`),line('EXPECTANCY',`$${sim.learning.meanNet.toFixed(2)} net / closed trade`,sim.learning.meanNet>=0?'g':'r'),line('HISTORY',m.live.historyStatus??'Connecting','y')] : []),
        ...refreshLines,...learningLines,
        '', sp('d', 'No broker orders are sent.'),
        sp('d', 'Fills use later observed trade volume.'),
        sp('d', 'Missing samples discard working quotes.'),
        sp('d', m.live.message || sim.queueAssumption),
      ].join('\n');
      this.setTitle('LIVE');
      return;
    }
    const value = (n: unknown, digits = 2): string => typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
    const note = (label: string, text: string): void => {
      const width = Math.max(24, cols - 11);
      const words = text.split(/\s+/);
      let line = "";
      for (const word of words) {
        if (line && line.length + word.length + 1 > width) {
          lines.push(L(label, sp("d", line)));
          label = "";
          line = "";
        }
        line += (line ? " " : "") + word;
      }
      if (line) lines.push(L(label, sp("d", line)));
    };
    const sierra = /^MNQZ26-CME(?:\[M\])?$/i.test(m.symbol) && String(m.source_note ?? "").includes("Sierra");
    if (sierra) {
      // Keep changing results visible in the small nine-panel layout. Full source
      // and model details remain below when the engine panel is focused.
      const evN = s.eventsUpTo(c.t);
      let submits = 0, cancels = 0, fills = 0;
      for (let i = 0; i < evN; i++) {
        if (s.eKind[i] === 1) submits++;
        else if (s.eKind[i] === 3) fills++;
        else if (s.eKind[i] === 4) cancels++;
      }
      lines.push(L("ENGINE", sp("w", `${m.engine.name} ${m.engine.crate_version}`)));
      lines.push(sp("y", c.playing ? "Sierra engine is running" : "Sierra engine is waiting for trades"));
      lines.push(L("POSITION", sp("w", `${value(accounting.position, 0)} contracts`)));
      if (accounting.terminal) lines.push(sp("y", "Terminal account; book: last sampled"));
      lines.push(L("ORDERS", sp("w", `${thousands(submits)} submitted`)));
      lines.push(L("FILLS", sp("c", `${thousands(fills)} executions`)));
      lines.push(L("CANCELS", sp("w", thousands(cancels))));
      lines.push(L("SOURCE", sp("w", "Sierra native ticks")));
      lines.push(L("SIZES", sp("y", String(m.source_note).includes("TOP-OF-BOOK SIMULATION") ? "assumed 1 contract" : "recorded market depth")));
    } else {
      lines.push(L("ENGINE", sp("w", `${m.engine.name} ${m.engine.crate_version}`) + sp("d", ` rust crate │ ${m.engine.rustc}`)));
    }
    const contractSize = m.models.asset?.contract_size ?? m.contract_size ?? 1;
    lines.push(L("MARKET", sp("w", `${m.symbol}`) + sp("d", ` ${m.exchange} │ tick ${m.tick_size} lot ${m.lot_size} │ cash/point ${contractSize}`)));
    if (m.source_note) note("SOURCE", String(m.source_note).replace(/\bSIMULATION\b/g, 'MODEL'));
    for (const d of m.data_files ?? []) {
      lines.push(L("DATA", sp("c", d.name) + sp("d", ` ${bytes(d.bytes)} │ ${thousands(d.rows)} rows`)));
      lines.push(L("", sp("d", `${d.first_local_iso.slice(0, 19).replace("T", " ")} → ${d.last_local_iso.slice(11, 19)} UTC │ ${thousands(d.trade_rows)} trades`)));
    }
    lines.push(L("SNAPSHOT", sp("", m.initial_snapshot ?? "reconstructed from feed")));
    const lat = m.models.latency;
    const latSrc = Array.isArray(lat.source) ? lat.source.join(", ") : lat.source ?? `${lat.entry_us / 1000}/${lat.response_us / 1000} ms`;
    lines.push(L("LATENCY", sp("w", lat.kind) + sp("d", ` ← ${latSrc}`)));
    const ol = s.collector?.order_latency;
    if (ol) {
      lines.push(
        L(
          "",
          sp("d", `order latency = feed latency × ${ol.mul_entry} (entry) / × ${ol.mul_resp} (response), interpolated │ p50 entry ${ol.entry_ms_p50.toFixed(0)}ms resp ${ol.resp_ms_p50.toFixed(0)}ms`),
        ),
      );
    }
    const q = m.models.queue;
    lines.push(L("QUEUE", sp("w", q.kind + (q.n !== undefined ? ` n=${q.n}` : "")) + sp("d", ` │ ${m.models.exchange}`)));
    const fee = m.models.fee;
    const feeRates = fee.kind === "TradingQtyFeeModel"
      ? `maker ${value(fee.maker)} / taker ${value(fee.taker)} cash per contract per side`
      : `maker ${value(fee.maker * 100, 4)}% taker ${value(fee.taker * 100)}%`;
    lines.push(L("FEES", sp("", `${fee.kind} ${feeRates}`)));
    const st = m.strategy;
    const ema = st.kind === "ema";
    lines.push(
      L(
        "STRATEGY",
        sp("d", ema ? "hftbacktest engine " : "hftbacktest tutorial ") +
          sp("w", ema ? (st.name ?? "9/21 EMA crossover on completed one-minute bars") : st.kind === "queue" ? "Queue-Based Market Making in Large Tick Size Assets" : st.kind === "grid" ? "High-Frequency Grid Trading" : (st.name ?? st.kind)),
      ),
    );
    lines.push(
      L(
        "",
        sp("d", ema
          ? `EMA ${st.ema_fast ?? 9}/${st.ema_slow ?? 21} │ completed ${st.bar_seconds ?? 60}s bars │ target ±${st.order_qty} │ ${st.time_in_force} ${st.order_type} │ ${st.decision_interval_ms}ms`
          : `${st.grid_num} levels/side × ${st.order_qty} │ half spread ${value(st.half_spread_ticks)}t │ grid ${st.grid_interval_ticks}t │ skew ${value(st.skew_ticks, 3)}t │ ${st.time_in_force} ${st.order_type} │ ${st.decision_interval_ms}ms`),
      ),
    );
    if (ema) {
      note("", `${st.execution ?? "marketable IOC limit at the opposite best"} │ max position ${st.max_position}`);
      if (st.bar_clock) note("BAR CLOCK", String(st.bar_clock));
    } else {
      lines.push(L("", sp("d", `fair price: ${st.fair_price ?? "mid"} │ max position ${st.max_position}`)));
    }
    const r = m.run;
    lines.push(
      L(
        "RUN",
        sp("w", `${thousands(r.events_total)} events`) +
          sp("d", ` in ${(r.wall_ms / 1000).toFixed(1)}s wall → `) +
          sp("c", `${thousands(Math.round(r.events_per_wall_sec))}/s`) +
          sp("d", ` │ ${thousands(r.submits)} orders, ${thousands(r.cancels)} cancels, ${thousands(r.fills)} fills`),
      ),
    );
    if (accounting.equity !== null) {
      lines.push(L(accounting.terminal ? "FINAL MTM" : "FRAME MTM", sp("w", `${value(accounting.equity)} cash net of fees`) + sp("d", ` │ fees ${value(accounting.fees)} │ open position ${value(accounting.position, 3)}`)));
      lines.push(L("", sp("d", `cash balance ${value(accounting.balance)} │ mark price ${value(accounting.markPrice)} │ equity includes unrealized P&L`)));
    }
    if (accounting.terminal) note("STATE", "Terminal accounting from recorded run totals. Book and working-order rows remain the last sampled snapshot.");
    const done = s.eventsLocal[f] + s.eventsExch[f];
    const frac = r.events_total ? done / r.events_total : 0;
    lines.push(
      L(
        "REPLAY",
        sp("w", clock(s.t0, c.t, true) + " UTC") +
          sp("d", ` │ frame ${f + 1}/${s.nFrames} │ ${c.playing ? "►" : "‖"} x${c.speed}`),
      ),
    );
    lines.push(L("", sp("d", `${thousands(done)} / ${thousands(r.events_total)} events `) + sp("c", bar(frac, Math.max(8, cols - 12 - 30))) + sp("d", ` ${(frac * 100).toFixed(1)}%`)));
    lines.push(L("", sp("d", `engine wall clock at this frame ${(s.wallMs[f] / 1000).toFixed(2)}s │ replay/wall ${((s.frameT[f] / 1e9) / Math.max(0.001, s.wallMs[f] / 1000)).toFixed(0)}x`)));
    this.body.innerHTML = lines.slice(0, this.rows).join("\n");
    this.setTitle(`${m.engine.runner}`);
  }
}

