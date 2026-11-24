/** Adapts observed Sierra snapshots and paper order events to the replay panels. */
import { Session, ST } from './session';
import type { Hbr, TypedArray } from './hbr';
import type { MarketTrade } from './original-live-tape';
import type { SimulationSnapshot } from './replay-simulation';
import type { LiveFrame } from './live-frame';
export type { LiveFrame } from './live-frame';

type ObservedFrame = { sourceMs: number; receivedMs: number; ageMs: number; frame: LiveFrame; sim: SimulationSnapshot };

export class LiveSessionBuffer {
  private frames: ObservedFrame[] = [];
  private trades = new Map<number, MarketTrade>();
  private generation = -1;
  private t0Ms = 0;
  private snapshots = 0;
  private tradeCount = 0;
  private lastSequence = -1;
  private rateStart = 0;
  private rates: Record<string, number[]> = { 'book snapshots': [], trade: [] };
  private samples: { t: number; k: string; s: string; len: number }[] = [];

  reset(): void {
    this.frames = [];
    this.trades.clear();
    this.t0Ms = this.snapshots = this.tradeCount = this.rateStart = 0;
    this.lastSequence = -1;
    this.rates = { 'book snapshots': [], trade: [] };
    this.samples = [];
  }

  accept(frame: LiveFrame, sim: SimulationSnapshot, receivedMs: number): Session {
    if (sim.generation !== this.generation) { this.reset(); this.generation = sim.generation; }
    const sourceMs = sim.sourceTimeMs || Math.max(0, ...frame.trades.map(t => t.timeMs)) || this.frames.at(-1)?.sourceMs || frame.publishedMs;
    // An empty startup tape has no source clock yet. When actual delayed trade
    // timestamps arrive, start a clean chart instead of mixing clock domains.
    if (this.frames.length && sourceMs < this.frames.at(-1)!.sourceMs) this.reset();
    if (!this.frames.length) this.t0Ms = Math.floor(sourceMs / 1000) * 1000 - 1000;
    if (this.frames.at(-1)?.frame.publishedMs !== frame.publishedMs) {
      const fresh = frame.trades.filter(t => t.sequence > this.lastSequence);
      const added = this.lastSequence < 0 ? 0 : fresh.length;
      for (const trade of frame.trades) this.trades.set(trade.sequence, trade);
      this.lastSequence = Math.max(this.lastSequence, ...frame.trades.map(t => t.sequence));
      this.tradeCount += added;
      this.snapshots++;
      this.frames.push({ sourceMs, receivedMs, ageMs: Math.max(0, receivedMs - frame.publishedMs), frame,
        sim: { ...sim, events: [], fills: [], logs: [], orders: sim.orders.filter(o => ['pending', 'working', 'canceling'].includes(o.state)) } });
      this.frames = this.frames.filter(f => f.sourceMs >= sourceMs - 120000).slice(-600);
      const second = Math.floor(sourceMs / 1000);
      if (!this.rateStart) this.rateStart = second;
      if (second - this.rateStart > 180) {
        const drop = second - this.rateStart - 120;
        for (const values of Object.values(this.rates)) values.splice(0, drop);
        this.rateStart += drop;
      }
      const index = Math.max(0, second - this.rateStart);
      for (const values of Object.values(this.rates)) while (values.length <= index) values.push(0);
      this.rates['book snapshots'][index]++;
      this.rates.trade[index] += added;
      this.samples.push({ t: sourceMs * 1e6, k: 'book snapshots', s: `${frame.bids.length} bid / ${frame.asks.length} ask · ${added} new trades`, len: 0 });
      this.samples = this.samples.slice(-400);
      if (this.trades.size > 20000) {
        const retained = [...this.trades.values()].sort((a, b) => b.timeMs - a.timeMs || b.sequence - a.sequence).slice(0, 15000);
        this.trades = new Map(retained.map(t => [t.sequence, t]));
      }
    }
    return this.view(frame, sim, receivedMs);
  }

  private view(current: LiveFrame, sim: SimulationSnapshot, receivedMs: number): Session {
    const frames = this.frames;
    const ns = (ms: number) => Number.isFinite(ms) ? (ms - this.t0Ms) * 1e6 : NaN;
    const arrays: Hbr['arrays'] = new Map();
    const add = (name: string, data: TypedArray) => arrays.set(name, { data, shape: [data.length] });
    const f64 = (name: string, values: number[]) => add(name, Float64Array.from(values));
    const f32 = (name: string, values: number[]) => add(name, Float32Array.from(values));
    const i32 = (name: string, values: number[]) => add(name, Int32Array.from(values));
    const u32 = (name: string, values: number[]) => add(name, Uint32Array.from(values));
    const tick = (price: number) => Math.round(price / current.tickSize);
    const levels = Math.max(1, ...frames.map(f => Math.max(f.frame.bids.length, f.frame.asks.length)));
    f64('frame_t', frames.map(f => ns(f.sourceMs)));
    i32('best_bid_tick', frames.map(f => f.frame.bids[0] ? tick(f.frame.bids[0][0]) : 0));
    i32('best_ask_tick', frames.map(f => f.frame.asks[0] ? tick(f.frame.asks[0][0]) : 0));
    for (const side of ['bid', 'ask'] as const) {
      const ticks: number[] = [], quantities: number[] = [];
      for (const f of frames) for (let level = 0; level < levels; level++) {
        const value = (side === 'bid' ? f.frame.bids : f.frame.asks)[level];
        ticks.push(value ? tick(value[0]) : 0); quantities.push(value?.[1] ?? 0);
      }
      i32(`${side}_tick`, ticks); f32(`${side}_qty`, quantities);
    }
    f32('position', frames.map(f => f.sim.position));
    i32('num_trades', frames.map(f => f.sim.fillCount));
    f32('volume', frames.map(f => f.sim.buyFillQty + f.sim.sellFillQty));
    for (const name of ['last', 'min', 'max', 'mean']) f32(`feed_lat_${name}`, frames.map(f => f.ageMs));
    u32('feed_batches', frames.map(() => 1));
    f64('events_local', frames.map(f => f.sim.tradeCount));
    f64('events_exch', frames.map(() => 0));
    f32('wall_ms', frames.map(f => f.receivedMs - frames[0].receivedMs));
    const orders = frames.flatMap(f => f.sim.orders.slice().sort((a, b) => b.price - a.price));
    let offset = 0;
    u32('order_start', [...frames.map(f => { const start = offset; offset += f.sim.orders.length; return start; }), offset]);
    const id = (value: string) => Number(value.replace(/^SIM-/, ''));
    f64('o_id', orders.map(o => id(o.id)));
    add('o_side', Int8Array.from(orders.map(o => o.side === 'buy' ? 1 : -1)));
    i32('o_tick', orders.map(o => tick(o.price)));
    f32('o_qty', orders.map(o => o.qty)); f32('o_leaves', orders.map(o => o.remaining));
    add('o_status', Uint8Array.from(orders.map(o => o.acknowledged ? ST.NEW : ST.NONE)));
    add('o_req', Uint8Array.from(orders.map(o => o.cancelMs !== null ? 4 : 0)));
    f32('o_front', orders.map(o => o.ahead)); f32('o_level', orders.map(o => o.initialAhead + o.qty));
    f64('o_submit_t', orders.map(o => ns(o.createdMs)));
    f64('o_ack_t', orders.map(o => o.acknowledged ? ns(o.activeMs + (o.responseLatencyMs ?? sim.responseLatencyMs)) : NaN));
    u32('o_trades_at_level', orders.map(o => o.tradedQuantity));
    const trades = [...this.trades.values()].sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
    f64('tr_exch_t', trades.map(t => ns(t.timeMs))); f64('tr_local_t', trades.map(t => ns(t.timeMs)));
    i32('tr_tick', trades.map(t => tick(t.price))); f32('tr_qty', trades.map(t => t.quantity));
    add('tr_side', Int8Array.from(trades.map(t => t.side === 'buy' ? 1 : -1)));
    const events = sim.events.slice().sort((a, b) => a.timeMs - b.timeMs || a.kind - b.kind);
    f64('e_t', events.map(e => ns(e.timeMs)));
    add('e_kind', Uint8Array.from(events.map(e => e.kind)));
    f64('e_id', events.map(e => id(e.orderId)));
    add('e_side', Int8Array.from(events.map(e => e.side === 'buy' ? 1 : -1)));
    i32('e_tick', events.map(e => tick(e.price))); f32('e_qty', events.map(e => e.qty));
    f64('e_req_t', events.map(e => ns(e.requestMs))); f64('e_exch_t', events.map(e => ns(e.exchangeMs)));
    f32('e_front', events.map(e => e.ahead)); f32('e_level', events.map(e => e.level));
    i32('e_exec_tick', events.map(e => tick(e.price))); f32('e_traded_at_level', events.map(e => e.tradedQuantity));
    const session = new Session({ arrays, meta: {
      t0_ns: String(BigInt(this.t0Ms) * 1000000n), tick_size: current.tickSize, lot_size: 1, frame_ns: 300e6,
      levels, n_frames: frames.length, symbol: current.symbol, exchange: 'CME',
      source_note: 'Sierra sampled live depth and trades. Orders and queues are estimates from observed snapshots; no broker orders.',
      live: { snapshotAgeMs: Math.max(0, receivedMs - current.publishedMs), delaySeconds: current.delaySeconds,
        bidLevels: current.bids.length, askLevels: current.asks.length, replay: current.replay,
        snapshots: this.snapshots, tradeCount: this.tradeCount, sim },
      engine: { name: 'Sampled-stream engine', crate_version: '', runner: 'LIVE' },
      models: { asset: { contract_size: 2 }, latency: { kind: sim.latencyMode === 'variable' ? 'VariableModeledLatency' : 'ConstantLatency', entry_us: sim.entryLatencyMs*1000, response_us: sim.responseLatencyMs*1000 },
        queue: { kind: 'Estimated queue' }, exchange: 'Sampled model', fee: { kind: 'TradingQtyFeeModel', maker: .75, taker: .75 } },
      strategy: { kind: sim.strategy, name: sim.strategy === 'liquidity' ? 'Liquidity zones' : 'Original queue maker',
        grid_num: sim.levelsPerSide, target_ticks: sim.targetTicks, stop_ticks: sim.stopTicks,
        order_qty: 1, max_position: 1, decision_interval_ms: sim.strategy === 'liquidity' ? 3000 : 1000 },
      run: { events_total: sim.tradeCount, wall_ms: receivedMs - frames[0].receivedMs,
        submits: sim.submits, cancels: sim.cancels, fills: sim.fillCount },
    } });
    session.collector = { file: 'Sierra live bridge', bytes: 0, lines: this.snapshots + this.tradeCount,
      first_ns: String(session.t0), last_ns: String(BigInt(Math.floor(session.endT)) + session.t0),
      streams: { 'book snapshots': this.snapshots, trade: this.tradeCount }, snapshots: this.snapshots,
      rate_t0_s: this.rateStart, rate: this.rates, sample: this.samples, sample_every: 1 };
    return session;
  }
}


