/** COLLECTOR: the raw websocket recording behind the session — file facts, message rate per stream,
 * and the raw lines that arrived at the moment being replayed (sampled). */
import { CH, CW, cssVar, el, fitCanvas, sp } from "../dom";
import { bytes, clock, lj, rj, thousands } from "../fmt";
import type { Session, SierraFacts } from "../session";
import { Panel, type RenderCtx } from "./base";

const STREAM_COLORS: Record<string, string> = {
  'book snapshots': '--cyan',
  "depth@0ms": "--cyan",
  trade: "--yellow",
  bookTicker: "--green",
  "depth snapshot (REST)": "--magenta",
};
const STREAM_LABEL: Record<string, string> = {
  'book snapshots': 'book',
  "depth@0ms": "depth",
  trade: "trade",
  bookTicker: "bookTicker",
  "depth snapshot (REST)": "snapshot",
};
const STREAM_CLS: Record<string, string> = {
  'book snapshots': 'c',
  "depth@0ms": "c",
  trade: "y",
  bookTicker: "g",
  "depth snapshot (REST)": "m",
};

export class CollectorPanel extends Panel {
  private readonly head: HTMLElement;
  private readonly rate: HTMLCanvasElement;
  private readonly tail: HTMLElement;

  constructor(s: Session) {
    super("collector", 9, "COLLECTOR", s);
    this.head = el("div", "", this.body);
    this.rate = el("canvas", "", this.body);
    this.rate.setAttribute('role', 'img');
    this.rate.setAttribute('aria-label', s.meta.live ? 'Observed book and trade update rates' : 'Collector message rates');
    this.tail = el("div", "", this.body);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const col = s.collector;
    const key = `${Math.floor(c.t / 1e8)}|${this.rows}|${this.cols}`;
    if (!this.changed(key)) return;
    if (s.sierraCollector) {
      this.renderSierra(s.sierraCollector);
      return;
    }
    if (!col) {
      this.head.innerHTML = sp("d", "no collector facts for this session");
      this.rate.hidden = true;
      this.tail.replaceChildren();
      this.setTitle("");
      return;
    }
    this.rate.hidden = false;
    const cols = this.cols;
    const W = cols * CW;
    const rows = this.rows;
    const t0 = s.t0;
    const nowAbs = t0 + BigInt(Math.floor(c.t));
    const nowSec = Number(nowAbs / 1000000000n);

    const streams = Object.keys(col.streams).sort();
    const h: string[] = [];
    if (s.meta.live) {
      const live = s.meta.live;
      h.push(sp('c', 'SIERRA') + sp('d', ` ${live.bidLevels} bid / ${live.askLevels} ask levels`));
      h.push(sp('d', 'FEED  ') + sp('y', `${live.delaySeconds.toFixed(1)}s reported delay`));
      h.push(streams.map(k => sp(STREAM_CLS[k] ?? '', STREAM_LABEL[k] ?? k) + sp('d', ` ${thousands(col.streams[k])}  `)).join(''));
    } else {
      h.push(sp("d", lj("RAW", 6)) + sp("c", col.source_file ?? col.file) + sp("d", ` ${bytes(col.source_bytes ?? col.bytes)} gz │ ${thousands(col.lines)} messages`));
      h.push(sp("d", lj("", 6)) + streams.map((k) => sp(STREAM_CLS[k] ?? "", STREAM_LABEL[k] ?? k) + sp("d", ` ${thousands(col.streams[k])}  `)).join(""));
    }
    if (col.npz) {
      h.push(sp("d", lj("NPZ", 6)) + sp("", `${col.npz.file} ${bytes(col.npz.bytes)} │ ${thousands(col.npz.rows)} events`) + sp("d", ` │ feed latency p50 ${col.npz.feed_latency_ms_p50.toFixed(1)}ms p99 ${col.npz.feed_latency_ms_p99.toFixed(1)}ms`));
    }
    // current rates
    const idx = nowSec - col.rate_t0_s;
    const cur = streams
      .filter((k) => k !== "depth snapshot (REST)")
      .map((k) => `${STREAM_LABEL[k] ?? k} ${rj(String(idx >= 0 && idx < (col.rate[k]?.length ?? 0) ? col.rate[k][idx] : 0), 4)}/s`)
      .join("  ");
    h.push(sp("d", lj("RATE", 6)) + sp("w", cur));
    this.head.innerHTML = h.join("\n");

    // rate chart: last 120 s, stacked per stream
    const chartRows = Math.max(3, Math.min(5, Math.floor(rows / 4)));
    const ctx = fitCanvas(this.rate, W, chartRows * CH);
    const H = this.rate.height;
    ctx.fillStyle = cssVar("--blue-dark");
    ctx.fillRect(0, 0, W, H);
    const span = Math.min(120, W);
    let vmax = 1;
    for (let i = 0; i < span; i++) {
      const j = idx - span + 1 + i;
      let tot = 0;
      for (const k of streams) tot += col.rate[k]?.[j] ?? 0;
      vmax = Math.max(vmax, tot);
    }
    const px = Math.max(1, Math.floor(W / span));
    for (let i = 0; i < span; i++) {
      const j = idx - span + 1 + i;
      if (j < 0) continue;
      let yBase = H;
      for (const k of streams) {
        const v = col.rate[k]?.[j] ?? 0;
        if (!v) continue;
        const hh = Math.max(1, Math.round((v / vmax) * (H - 2)));
        ctx.fillStyle = cssVar(STREAM_COLORS[k] ?? "--gray");
        ctx.fillRect(i * px, yBase - hh, px, hh);
        yBase -= hh;
      }
    }
    ctx.fillStyle = cssVar("--gray");
    ctx.font = "8px EGA8";
    ctx.textBaseline = "top";
    ctx.fillText(`${vmax} msg/s`, 2, 2);
    ctx.fillText("-120s", 2, H - 9);

    // raw tail: sampled lines received up to now
    const tailRows = rows - (s.meta.live ? 5 : 4) - chartRows;
    const lines: string[] = [];
    const samples = col.sample;
    // binary search by t (absolute ns as number is fine for ordering)
    let lo = 0;
    let hi = samples.length;
    const nowNum = Number(nowAbs);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= nowNum) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && lines.length < tailRows; i--) {
      const smp = samples[i];
      const rel = smp.t - Number(t0);
      const kind = STREAM_LABEL[smp.k] ?? smp.k;
      const c2 = STREAM_CLS[smp.k] ?? "";
      const prefix = `${clock(t0, rel, true)} ${lj(kind, 10)} `;
      const room = Math.max(8, cols - prefix.length - 1);
      lines.unshift(sp("d", clock(t0, rel, true) + " ") + sp(c2, lj(kind, 10)) + " " + sp("", smp.s.slice(0, room)));
    }
    this.tail.innerHTML = lines.join("\n");
    this.setTitle(s.meta.live ? 'Sierra · observed update rate' : `1 of ${col.sample_every} messages shown │ ${col.snapshots} REST snapshot${col.snapshots === 1 ? "" : "s"}`);
  }

  private renderSierra(facts: SierraFacts): void {
    this.rate.hidden = true; // Native source facts have no websocket-rate series.
    const modeled = facts.source_mode === 'quotes' || facts.quotes_modeled === true;
    const line = (label: string, value: string, cls = 'w') => sp('d', lj(label, 11)) + sp(cls, value);
    const filename = (value: string) => value.split(/[\\/]/).at(-1) || value;
    const count = (value: number | undefined) => Number.isFinite(value) ? thousands(value!) : 'unavailable';
    const h = [
      line('SOURCE', 'Sierra native tick data', 'c'),
      line('MODE', modeled ? 'QUOTE MODEL' : 'RECORDED L2', modeled ? 'y' : 'c'),
      line('TRADES', `${count(facts.trade_records)} individual ticks`),
      ...(modeled ? [
        line('SIZES', `ASSUMED ${facts.assumed_quote_quantity ?? 'unknown'} contract / side`, 'y'),
        line('QUOTES', `${count(facts.quote_records)} saved bid/ask records`),
        line('L2 DEPTH', 'unavailable; sizes modeled', 'y'),
      ] : [
        line('DEPTH', `${count(facts.depth_records)} native records`),
        line('BATCHES', count(facts.depth_batches)),
      ]),
      line('QUEUE/FILL', 'hftbacktest model estimates', 'y'),
    ];
    this.head.innerHTML = h.join('\n');
    const details = [
      '', line('TRADE FILE', filename(facts.trade_file)),
      ...(facts.depth_file ? [line('DEPTH FILE', filename(facts.depth_file))] : []),
      ...(facts.npz ? [line('NORMALIZED', `${count(facts.npz.rows)} events / ${bytes(facts.npz.bytes)}`)] : []),
      ...(modeled ? [line('QUOTE CHG', count(facts.quote_changes))] : []),
      line('START BOOK', `${count(facts.initial_bid_levels)} bid / ${count(facts.initial_ask_levels)} ask levels`),
      line('FEED LAT', facts.feed_latency_measured ? 'see source facts' : 'unknown; assumed zero', 'y'),
    ];
    if (facts.modeled_order_latency_us?.length === 2) {
      details.push(line('ORDER LAT', `${facts.modeled_order_latency_us[0] / 1000} / ${facts.modeled_order_latency_us[1] / 1000} ms assumed`, 'y'));
    }
    const columns = Math.max(16, this.cols);
    const sourceNote = (facts.source_note || facts.source).replace(/\bSIMULATION\b/g, 'MODEL');
    details.push('');
    // Keep the provenance readable when the Collector occupies a narrow tile.
    for (const paragraph of sourceNote.split('\n')) {
      let current = '';
      for (const word of paragraph.split(/\s+/)) {
        if (current && current.length + word.length + 1 > columns) {
          details.push(sp('d', current)); current = '';
        }
        current += (current ? ' ' : '') + word;
      }
      if (current) details.push(sp('d', current));
    }
    this.tail.innerHTML = details.join('\n');
    this.setTitle(modeled ? 'SIERRA · sizes assumed' : 'SIERRA · recorded depth');
  }
}
