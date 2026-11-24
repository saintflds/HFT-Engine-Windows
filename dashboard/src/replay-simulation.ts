/**
 * Deterministic paper quotes driven only by sampled Sierra trades.
 * This is a teaching/display model, not the Rust HFT backtester or an exchange
 * queue reconstruction. It never communicates with a trading API.
 *
 * A quote joins behind the quantity in the latest observed book. Only later
 * opposing prints consume that modeled queue. A print through the limit does
 * not magically clear its queue: only the observed print quantity is credited.
 * Cancellations, hidden liquidity and unobserved prints do not advance it.
 * Book snapshots arrive after each sampled batch and never affect its earlier
 * trades. All timers use source event time; polling and wall time cannot fill.
 */
import type { MarketTrade } from "./original-live-tape";

type Side = "buy" | "sell";
type Level = readonly [price: number, quantity: number, orders: number];
export type SimulationFrame = {
  symbol: string;
  replay: boolean;
  publishedMs: number;
  tickSize: number;
  last: number;
  bids: readonly Level[];
  asks: readonly Level[];
  trades: readonly MarketTrade[];
};
export type SimulationOrder = {
  id: string;
  side: Side;
  price: number;
  qty: number;
  remaining: number;
  ahead: number;
  initialAhead: number;
  state: "pending" | "working" | "canceling" | "filled" | "canceled";
  createdMs: number;
  activeMs: number;
  cancelMs: number | null;
  reason?: string;
  role?: "demand" | "supply" | "exit";
  market?: boolean;
  entryLatencyMs?: number;
  responseLatencyMs?: number;
  cancelRequestMs?: number;
  cancelResponseMs?: number;
  acknowledged: boolean;
  tradedQuantity: number;
};
type OrderSafety = {
  allowOrder(): boolean;
  checkRisk(position: number, equity: number, positionLimit: number): void;
};
export type SimulationOptions = { strategy?: "queue" | "liquidity"; levels?: number; allowLive?: boolean; latency?: 'constant' | 'variable'; adaptive?: boolean; orderSafety?: OrderSafety };
export type ClosedTrade = { id: number; entryMs: number; exitMs: number; side: Side; entryPrice: number; exitPrice: number; gross: number; fees: number; net: number; reason: string; maeTicks: number; mfeTicks: number; riskLevel: number; signal: SignalState };
export type SignalState = { flow: number; depth: number; momentumTicks: number; rangeTicks: number; spreadTicks: number; prints: number; warmed: boolean };
export type GateRecord = { name: string; value: number | Record<string, number> | null; threshold: number | null; pass: boolean; note?: string };
export type DecisionDiagnostic = {
  t: number;
  position: number;
  riskLevel: number;
  /** Engine's own first-rejection reason (decision text chain). */
  firstReason: string;
  /** Every entry gate evaluated independently: actual value, threshold, pass/fail. */
  gates: GateRecord[];
  /** ALL simultaneously failing conditions (not just the first). */
  failingGates: string[];
  /** True when every global gate and at least one side's full gate set pass. */
  jointPassAnySide: boolean;
  /** Prices the engine actually chose to quote this decision. */
  candidatePrices: { buy: number[]; sell: number[] };
  neural: string;
};
export type LearningChange = { id: number; timeMs: number; from: number; to: number; meanNet: number; winRate: number; reason: string };
export function modeledDelay(key: number, phase: number): number {
  let x = (Math.floor(key) ^ Math.imul(phase + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  const u = ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  return Math.round((u < .94 ? 4 + 20 * u / .94 : 24 + 36 * (u - .94) / .06) * 10) / 10;
}
export function learningDecision(outcomes: number[], level: number): {level:number;meanNet:number;winRate:number} {
  const sample=outcomes.filter(Number.isFinite).slice(-20);
  const meanNet=sample.reduce((a,b)=>a+b,0)/Math.max(1,sample.length),winRate=sample.filter(n=>n>0).length/Math.max(1,sample.length);
  return {level:sample.length<20?level:meanNet<0?Math.min(2,level+1):meanNet>1&&winRate>=.55?Math.max(0,level-1):level,meanNet,winRate};
}
export type SimulationEvent = {
  sequence: number;
  reason?: string;
  market?: boolean;
  kind: 1 | 2 | 3 | 4 | 5;
  orderId: string;
  side: Side;
  price: number;
  qty: number;
  timeMs: number;
  requestMs: number;
  exchangeMs: number;
  ahead: number;
  level: number;
  tradedQuantity: number;
};
export type SimulationFill = {
  id: string;
  orderId: string;
  timeMs: number;
  responseMs: number;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  /** Gross realized P&L closed by this fill; the fee is separate. */
  realized: number;
};
export type SimulationSnapshot = {
  executionVersion: 'response-aware-v1';
  latencyMode: 'constant' | 'variable';
  strategyVersion: string;
  signal: SignalState;
  neural: {buy:number;sell:number;flat:number}|null;
  learning: { enabled: boolean; riskLevel: number; samples: number; nextReview: number; meanNet: number; winRate: number; outcomes: number[]; changes: LearningChange[] };
  closedTrades: ClosedTrade[];
  cooldownMs: number;
  mode: "sampled-replay-paper" | "sampled-live-paper";
  status: "off" | "waiting" | "running" | "blocked";
  timeMs: number;
  sourceTimeMs: number;
  orders: SimulationOrder[];
  fills: SimulationFill[];
  logs: { timeMs: number; message: string }[];
  position: number;
  cash: number;
  equity: number;
  realized: number;
  unrealized: number;
  fees: number;
  submits: number;
  cancels: number;
  tradeCount: number;
  volume: number;
  buyFillQty: number;
  sellFillQty: number;
  entryLatencyMs: number;
  responseLatencyMs: number;
  feePerContract: number;
  pointValue: number;
  maxPosition: number;
  markPrice: number;
  quotesOnly: boolean;
  queueAssumption: string;
  /** Unverified sample-coverage breaks, not an exact missing-trade count. */
  dataGaps: number;
  generation: number;
  events: SimulationEvent[];
  fillCount: number;
  strategy: "queue" | "liquidity";
  levelsPerSide: number;
  targetTicks: number;
  stopTicks: number;
  decision: string;
};

const finite = (value: number) => Number.isFinite(value);
const working = (order: SimulationOrder) => order.state === "pending" || order.state === "working" || order.state === "canceling";
const ENTRY_MS = 10;
const RESPONSE_MS = 10;
const FEE = 0.75;
const POINT_VALUE = 2;
const MAX_POSITION = 1;
const QUOTE_INTERVAL_MS = 1000;
const BRIDGE_TRADE_WINDOW = 100;

export class ReplaySimulation {
  private strategy: "queue" | "liquidity";
  private levels: number;
  private readonly allowLive: boolean;
  readonly #orderSafety?: OrderSafety;
  #retired = false;
  private readonly latencyMode: 'constant' | 'variable';
  private readonly adaptive: boolean;
  private learningEnabled = true;
  private predictor:((signal:SignalState,timeMs:number)=>{buy:number;sell:number;flat:number}|null)|null=null;
  private neural:{buy:number;sell:number;flat:number}|null=null;
  setPredictor(predictor:typeof this.predictor):void{this.predictor=predictor;}
  private targetTicks = 8;
  private stopTicks = 12;
  private riskLevel = 0;
  private outcomes: number[] = [];
  private reviewsSince = 0;
  private changes: LearningChange[] = [];
  private closedTrades: ClosedTrade[] = [];
  private nextClosed = 1;
  private nextEvent = 1;
  private recentTrades: {bucket:number;timeMs:number;endMs:number;price:number;lastPrice:number;high:number;low:number;buyVolume:number;sellVolume:number;prints:number}[] = [];
  private signal: SignalState = {flow:0,depth:0,momentumTicks:0,rangeTicks:0,spreadTicks:0,prints:0,warmed:false};
  private entryRecord: {timeMs:number;price:number;side:Side;fees:number;gross:number;mae:number;mfe:number;riskLevel:number;signal:SignalState} | null = null;
  private lastClosedMs = -Infinity;
  private stableLevels = new Map<string,number>();
  private get cooldownMs(): number { return 3000 + this.riskLevel * 5000; }
  private get minFlow(): number { return .12 + this.riskLevel * .08; }
  setLearning(enabled: boolean): void { this.learningEnabled = enabled; }
  restoreLearning(profile: {outcomes?:number[];riskLevel?:number;reviewsSince?:number}): void {
    if (this.source || !this.adaptive) return;
    this.outcomes = (profile.outcomes??[]).filter(Number.isFinite).slice(-100);
    this.riskLevel=Math.max(0,Math.min(2,Math.floor(profile.riskLevel??0)));
    this.reviewsSince=Math.max(0,Math.min(19,Math.floor(profile.reviewsSince??0)));
  }
  private positionSince = 0;
  private decision = "Waiting for market depth";
  constructor(options: SimulationOptions = {}) {
    this.strategy = options.strategy ?? "queue";
    this.levels = Math.max(1, Math.min(5, Math.floor(Number.isFinite(options.levels) ? options.levels! : 3)));
    this.allowLive = options.allowLive === true;
    this.#orderSafety = options.orderSafety;
    this.latencyMode = options.latency ?? 'variable';
    this.adaptive = options.adaptive === true;
    if (this.adaptive) { this.targetTicks=12; this.stopTicks=8; }
  }
  configure(options: Pick<SimulationOptions, "strategy" | "levels">): void {
    this.strategy = options.strategy ?? "liquidity";
    this.levels = Math.max(1, Math.min(5, Math.floor(Number.isFinite(options.levels) ? options.levels! : 3)));
    this.reset();
  }
  private generation = 0;
  private events: SimulationEvent[] = [];
  private fillCount = 0;
  private status: SimulationSnapshot["status"] = "waiting";
  private source: { symbol: string; replay: boolean; publishedMs: number; tickSize: number } | null = null;
  private lastSequence: number | null = null;
  private lastTradeTime: number | null = null;
  private timeMs = 0;
  private lastQuoteMs = -Infinity;
  private orders: SimulationOrder[] = [];
  private fills: SimulationFill[] = [];
  private logs: SimulationSnapshot["logs"] = [];
  private nextOrder = 1;
  private nextFill = 1;
  // Exchange state is private: strategy/account state changes only on receipt.
  private exchangePosition = 0;
  private exchange = new Map<string,{remaining:number;state:'working'|'filled'|'canceled'}>();
  private responses: {due:number;apply:()=>void}[] = [];
  private lastFillResponseMs = 0;
  private position = 0;
  private averageEntry = 0;
  private cash = 0;
  private realized = 0;
  private fees = 0;
  private markPrice = 0;
  private submits = 0;
  private cancels = 0;
  private tradeCount = 0;
  private volume = 0;
  private buyFillQty = 0;
  private sellFillQty = 0;
  private dataGaps = 0;
  private quotesOnly = true;
  private diagEnabled = false;
  private diagLog: DecisionDiagnostic[] = [];
  /**
   * Read-only per-gate decision diagnostics. Off by default; when enabled it
   * only appends to diagLog and never mutates trading state.
   */
  setDiagnostics(enabled: boolean): void {
    this.diagEnabled = enabled;
    if (!enabled) this.diagLog = [];
  }
  get diagnostics(): readonly DecisionDiagnostic[] { return this.diagLog; }

  reset(): void {
    if(this.source?.replay){this.outcomes=[];this.riskLevel=0;this.reviewsSince=0;}
    this.entryRecord=null; this.recentTrades=[]; this.stableLevels.clear(); this.lastClosedMs=-Infinity;
    this.closedTrades=[]; this.changes=[]; this.nextClosed=1; this.nextEvent=1;
    this.signal={flow:0,depth:0,momentumTicks:0,rangeTicks:0,spreadTicks:0,prints:0,warmed:false};
    this.exchangePosition=0;this.exchange.clear();this.responses=[];this.lastFillResponseMs=0;
    this.positionSince = 0;
    this.decision = "Waiting for market depth";
    this.generation++;
    this.events = [];
    this.fillCount = 0;
    this.status = "waiting";
    this.source = null;
    this.lastSequence = null;
    this.lastTradeTime = null;
    this.timeMs = 0;
    this.lastQuoteMs = -Infinity;
    this.orders = [];
    this.fills = [];
    this.logs = [];
    this.nextOrder = this.nextFill = 1;
    this.position = this.averageEntry = this.cash = this.realized = this.fees = this.markPrice = 0;
    this.submits = this.cancels = this.tradeCount = this.volume = this.buyFillQty = this.sellFillQty = this.dataGaps = 0;
    this.quotesOnly = true;
  }

  suspend(): void {
    this.discardQuotes('Feed unavailable; quotes discarded before resuming.');
    this.#pauseQuoting();
    this.status = 'waiting';
  }

  #pauseQuoting(): void {
    this.lastSequence = null;
    this.lastTradeTime = null;
    this.lastQuoteMs = -Infinity;
    this.recentTrades = [];
    this.stableLevels.clear();
  }

  block(): void {
    if (this.status === 'blocked') return;
    this.#pauseQuoting();
    this.status = 'blocked';
    this.decision = 'Paper order routing blocked';
  }

  settleWhileBlocked(frame?: SimulationFrame): void {
    this.block();
    if (this.#retired || !frame || !this.source || frame.symbol !== this.source.symbol
      || frame.replay !== this.source.replay || frame.tickSize !== this.source.tickSize
      || frame.publishedMs < this.source.publishedMs) return;
    // Advance only the clock used to deliver responses already on the
    // exchange queue. Do not match prints or feed them into the strategy.
    for (const trade of frame.trades) {
      if (finite(trade.timeMs) && trade.timeMs > this.timeMs) this.timeMs = trade.timeMs;
    }
    this.advanceOrders();
  }

  retire(): void {
    this.#retired = true;
    this.reset();
    this.block();
  }

  accept(frame: SimulationFrame, enabled: boolean): void {
    if (this.#retired) return;
    if (!enabled || (!frame.replay && !this.allowLive) || !/^MNQZ26-CME(?:\[M\])?$/i.test(frame.symbol)
      || frame.tickSize !== 0.25) {
      if (this.status !== "off") this.reset();
      this.status = "off";
      return;
    }
    if (this.status === "off") this.reset();
    if (this.status === "blocked") this.status = "waiting";
    if (!finite(frame.publishedMs) || !finite(frame.tickSize) || frame.tickSize <= 0) return;

    if (this.source && (this.source.symbol !== frame.symbol || this.source.replay !== frame.replay
      || frame.publishedMs < this.source.publishedMs || this.source.tickSize !== frame.tickSize)) {
      this.outcomes=[]; this.riskLevel=0; this.reviewsSince=0;
      this.restart("Source changed; engine account reset.");
    }
    const unique = new Map<number, MarketTrade>();
    for (const trade of frame.trades) {
      if (Number.isSafeInteger(trade.sequence) && trade.sequence >= 0 && finite(trade.timeMs) && trade.timeMs > 0
        && finite(trade.price) && trade.price > 0 && finite(trade.quantity) && trade.quantity >= 1
        && (trade.side === "buy" || trade.side === "sell")) unique.set(trade.sequence, trade);
    }
    const trades = [...unique.values()].sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
    if (!this.source && frame.replay) { this.outcomes=[]; this.riskLevel=0; this.reviewsSince=0; }
    this.source = { symbol: frame.symbol, replay: frame.replay, publishedMs: frame.publishedMs, tickSize: frame.tickSize };
    this.quotesOnly = frame.bids.length <= 1 && frame.asks.length <= 1;
    if (!trades.length) {
      // Replay seeks start a new account timeline. An empty live publication
      // suspends quotes but preserves the account, like a feed interruption.
      if (this.lastSequence !== null) {
        if (frame.replay) {
          this.restart("Replay tape cleared; engine account reset.");
          this.source = { symbol: frame.symbol, replay: frame.replay, publishedMs: frame.publishedMs, tickSize: frame.tickSize };
        } else this.suspend();
      }
      return;
    }
    const maximumSequence = Math.max(...trades.map((trade) => trade.sequence));
    const latestTime = trades.at(-1)!.timeMs;
    if ((this.lastSequence !== null && maximumSequence < this.lastSequence)
      || (this.lastTradeTime !== null && latestTime < this.lastTradeTime)) {
      this.restart("Replay moved backward; engine account reset.");
      this.source = { symbol: frame.symbol, replay: frame.replay, publishedMs: frame.publishedMs, tickSize: frame.tickSize };
    }

    if (this.lastSequence === null) {
      this.seed(frame, maximumSequence, latestTime);
      return;
    }
    const fresh = trades.filter((trade) => trade.sequence > this.lastSequence!);
    if (!fresh.length) return; // Paused/duplicate publications never advance time.
    const overlap = trades.some((trade) => trade.sequence === this.lastSequence);
    if (!overlap && trades.length >= BRIDGE_TRADE_WINDOW) {
      this.dataGaps++;
      this.discardQuotes("Sample coverage unverified; working quotes discarded.");
      this.log("No overlap in the 100-trade sample; omitted events are possible. No fills modeled for this batch.");
      this.seed(frame, maximumSequence, latestTime);
      return;
    }
    if (fresh.some((trade) => trade.timeMs < this.timeMs)) {
      this.dataGaps++;
      this.discardQuotes("Out-of-order source time; working quotes discarded.");
      this.seed(frame, maximumSequence, latestTime);
      return;
    }
    let previousSequence = this.lastSequence;
    let sequenceSkip = false;
    for (const trade of fresh) {
      if (trade.sequence > previousSequence + 1) sequenceSkip = true;
      previousSequence = trade.sequence;
      this.timeMs = trade.timeMs;
      this.advanceOrders();
      this.tradeCount++;
      this.volume += Math.floor(trade.quantity);
      this.markPrice = trade.price;
      // Keep a time window, not a print-count cap: busy tape must still warm up.
      const bucket=Math.floor(trade.timeMs/100),last=this.recentTrades.at(-1);
      if(last?.bucket===bucket){last.endMs=trade.timeMs;last.lastPrice=trade.price;last.high=Math.max(last.high,trade.price);last.low=Math.min(last.low,trade.price);last.prints++;if(trade.side==='buy')last.buyVolume+=trade.quantity;else last.sellVolume+=trade.quantity;}
      else this.recentTrades.push({bucket,timeMs:trade.timeMs,endMs:trade.timeMs,price:trade.price,lastPrice:trade.price,high:trade.price,low:trade.price,buyVolume:trade.side==='buy'?trade.quantity:0,sellVolume:trade.side==='sell'?trade.quantity:0,prints:1});
      while(this.recentTrades.length&&this.recentTrades[0].timeMs<this.timeMs-20000)this.recentTrades.shift();
      if (this.entryRecord && this.position) {
        const move=Math.sign(this.position)*(trade.price-this.entryRecord.price)/frame.tickSize;
        this.entryRecord.mae=Math.max(this.entryRecord.mae,-move); this.entryRecord.mfe=Math.max(this.entryRecord.mfe,move);
      }
      this.#checkRisk();
      if (!this.#canRoute()) return this.settleWhileBlocked(frame);
      this.consume(trade);
      this.#checkRisk();
      if (!this.#canRoute()) return this.settleWhileBlocked(frame);
      this.protectPosition(frame.tickSize);
    }
    if (sequenceSkip) this.log("Sequence discontinuity observed; Sierra sequences may include unexported non-trade events.");
    this.lastSequence = maximumSequence;
    this.lastTradeTime = latestTime;
    this.timeMs = latestTime;
    // Only now may this batch's most recent book influence future quotes.
    this.requote(frame);
    if (this.#canRoute()) this.status = this.validBook(frame) ? "running" : "waiting";
    this.trim();
  }

  snapshot(): SimulationSnapshot {
    const unrealized = this.position * (this.markPrice - this.averageEntry) * POINT_VALUE;
    return {
      executionVersion:'response-aware-v1',
      mode: this.source?.replay === false ? "sampled-live-paper" : "sampled-replay-paper",
      status: this.status, timeMs: this.timeMs, sourceTimeMs: this.timeMs,
      orders: this.orders.slice().reverse().map((order) => ({ ...order })),
      fills: this.fills.slice().reverse().map((fill) => ({ ...fill })),
      logs: this.logs.slice().reverse().map((line) => ({ ...line })),
      position: this.position, cash: this.cash,
      equity: this.cash + this.position * this.markPrice * POINT_VALUE,
      realized: this.realized, unrealized, fees: this.fees,
      submits: this.submits, cancels: this.cancels, tradeCount: this.tradeCount, volume: this.volume,
      buyFillQty: this.buyFillQty, sellFillQty: this.sellFillQty,
      entryLatencyMs: this.orders.at(-1)?.entryLatencyMs ?? ENTRY_MS, responseLatencyMs: this.orders.at(-1)?.responseLatencyMs ?? RESPONSE_MS, feePerContract: FEE,
      latencyMode:this.latencyMode, strategyVersion:this.adaptive?'liquidity-flow-v2':'legacy-v1', cooldownMs:this.cooldownMs,
      signal: {...this.signal, warmed: this.status !== 'blocked' && this.signal.warmed},
      neural: this.status === 'blocked' ? null : this.neural,
      closedTrades:this.closedTrades.map(t=>({...t,signal:{...t.signal}})),
      learning:{enabled:this.adaptive&&this.strategy==='liquidity'&&this.learningEnabled,riskLevel:this.riskLevel,samples:this.outcomes.length,nextReview:20-this.reviewsSince,outcomes:[...this.outcomes],
        ...learningDecision(this.outcomes,this.riskLevel), changes:this.changes.map(c=>({...c}))},
      pointValue: POINT_VALUE, maxPosition: MAX_POSITION, markPrice: this.markPrice,
      quotesOnly: this.quotesOnly, dataGaps: this.dataGaps, generation: this.generation,
      events: this.events.map(event => ({ ...event })), fillCount: this.fillCount,
      strategy: this.strategy, levelsPerSide: this.strategy === "liquidity" ? this.levels : 1,
      targetTicks: this.targetTicks, stopTicks: this.stopTicks, decision: this.decision,
      queueAssumption: this.quotesOnly
        ? "Sampled-stream model; top-of-book sizes may be synthetic. Only later opposing print volume advances the estimated queue."
        : "Sampled-stream model; join behind observed size. Only later opposing print volume advances queue; hidden orders and cancellations are unknown.",
    };
  }

  private restart(message: string): void {
    this.reset();
    this.log(message);
  }

  private seed(frame: SimulationFrame, sequence: number, timeMs: number): void {
    this.lastSequence = sequence;
    this.lastTradeTime = timeMs;
    this.timeMs = timeMs;
    this.markPrice = finite(frame.last) && frame.last > 0 ? frame.last : frame.trades.find((trade) => trade.timeMs === timeMs)?.price || 0;
      this.log("Quotes seeded at latest source event; previously displayed trades cannot fill them.");
    this.requote(frame, true);
    if (this.#canRoute()) this.status = this.validBook(frame) ? "running" : "waiting";
    this.trim();
  }

  private validBook(frame: SimulationFrame): boolean {
    const bid = frame.bids[0], ask = frame.asks[0];
    return Boolean(bid && ask && finite(bid[0]) && finite(ask[0]) && bid[0] > 0 && ask[0] > bid[0]
      && finite(bid[1]) && finite(ask[1]) && bid[1] >= 0 && ask[1] >= 0
      && Math.abs(bid[0] / frame.tickSize - Math.round(bid[0] / frame.tickSize)) < 1e-5
      && Math.abs(ask[0] / frame.tickSize - Math.round(ask[0] / frame.tickSize)) < 1e-5);
  }

  private respond(due:number,apply:()=>void):void {
    this.responses.push({due,apply});
    this.responses.sort((a,b)=>a.due-b.due);
  }

  private advanceOrders(): void {
    const now=this.timeMs;
    while(this.responses.length&&this.responses[0].due<=now){
      const response=this.responses.shift()!;
      this.timeMs=response.due;response.apply();
    }
    this.timeMs=now;
  }

  private consume(trade: MarketTrade): void {
    // Price/time priority; one observed print's volume is never reused.
    let volume = Math.floor(trade.quantity);
    const ordered = this.orders.slice().sort((a, b) => Number(Boolean(b.market)) - Number(Boolean(a.market))
      || (a.side === b.side ? (a.side === "buy" ? b.price - a.price : a.price - b.price) : 0)
      || a.createdMs - b.createdMs);
    for (const order of ordered) {
      const ex=this.exchange.get(order.id);
      if (!volume || !ex || ex.state!=='working' || this.timeMs < order.activeMs
        || (order.cancelMs !== null && this.timeMs >= order.cancelMs)) continue;
      if (order.market) {
        const closes = order.side === "sell" ? this.exchangePosition > 0 : this.exchangePosition < 0;
        if (!closes) {
          ex.state='canceled';const at=this.timeMs,due=at+this.responseDelay(order,3);
          this.respond(due,()=>{order.state='canceled';this.cancels++;this.event(5,order,due,order.createdMs,at);});continue;
        }
        const qty = Math.min(ex.remaining, volume, Math.abs(this.exchangePosition));
        // Next observed print after entry latency, plus one adverse tick.
        order.price = trade.price + (order.side === "buy" ? 1 : -1) * this.source!.tickSize;
        this.fill(order, qty);
        volume -= qty;
        continue;
      }
      const reaches = order.side === "buy" ? trade.side === "sell" && trade.price <= order.price
        : trade.side === "buy" && trade.price >= order.price;
      if (!reaches) continue;
      if (trade.price === order.price) order.tradedQuantity += volume;
      const usedAhead = Math.min(order.ahead, volume);
      order.ahead -= usedAhead;
      volume -= usedAhead;
      const direction = order.side === "buy" ? 1 : -1;
      const capacity = Math.max(0, MAX_POSITION - direction * this.exchangePosition);
      const qty = Math.min(ex.remaining, volume, capacity);
      if (!qty) continue;
      this.fill(order, qty);
      volume -= qty;
    }
  }

  private fill(order:SimulationOrder,qty:number):void {
    const ex=this.exchange.get(order.id)!;
    ex.remaining-=qty;if(!ex.remaining)ex.state='filled';
    this.exchangePosition+=(order.side==='buy'?1:-1)*qty;
    const at=this.timeMs,price=order.price;
    // Ordered fill reports prevent response jitter from reversing account history.
    const due=Math.max(at+this.responseDelay(order,3),order.activeMs+(order.responseLatencyMs??RESPONSE_MS),this.lastFillResponseMs);
    this.lastFillResponseMs=due;
    this.respond(due,()=>this.receiveFill(order,qty,price,at,due));
  }

  private receiveFill(order: SimulationOrder, qty: number, price:number, exchangeMs:number, responseMs:number): void {
    const direction = order.side === "buy" ? 1 : -1;
    const oldPosition = this.position;
    const closing = oldPosition * direction < 0 ? Math.min(Math.abs(oldPosition), qty) : 0;
    const realized = closing * (price - this.averageEntry) * Math.sign(oldPosition) * POINT_VALUE;
    const fee = qty * FEE;
    if (!oldPosition) this.entryRecord={timeMs:exchangeMs,price:price,side:order.side,fees:0,gross:0,mae:0,mfe:0,riskLevel:this.riskLevel,signal:{...this.signal}};
    if (this.entryRecord) { this.entryRecord.fees+=fee; this.entryRecord.gross+=realized; }
    this.position += direction * qty;
    if (!oldPosition && this.position) this.positionSince = exchangeMs;
    if (!this.position) this.positionSince = 0;
    if (!this.position) this.averageEntry = 0;
    else if (!oldPosition || Math.sign(oldPosition) !== Math.sign(this.position)) this.averageEntry = price;
    else if (oldPosition * direction > 0) this.averageEntry = (this.averageEntry * Math.abs(oldPosition) + price * qty) / Math.abs(this.position);
    this.cash -= direction * price * qty * POINT_VALUE + fee;
    this.realized += realized;
    this.fees += fee;
    if (direction > 0) this.buyFillQty += qty; else this.sellFillQty += qty;
    order.remaining -= qty;
    if (!order.remaining) order.state = "filled";
    if (this.strategy === "liquidity" && this.#canRoute() && this.status !== "blocked") {
      for (const other of this.orders) if (other !== order && !other.market && working(other) && other.cancelMs === null) {
        this.requestCancel(other);
      }
      this.lastQuoteMs = -Infinity;
    }
    this.fills.push({ id: `F-${this.nextFill++}`, orderId: order.id, timeMs: exchangeMs, responseMs,
      side: order.side, price: price, qty, fee, realized });
    this.fillCount++;
    if (!this.position && this.entryRecord) {
      const r=this.entryRecord, net=r.gross-r.fees;
      this.closedTrades.push({id:this.nextClosed++,entryMs:r.timeMs,exitMs:exchangeMs,side:r.side,entryPrice:r.price,exitPrice:price,gross:r.gross,fees:r.fees,net,reason:order.reason??'FILL',maeTicks:r.mae,mfeTicks:r.mfe,riskLevel:r.riskLevel,signal:r.signal});
      this.closedTrades=this.closedTrades.slice(-100); this.entryRecord=null; this.lastClosedMs=this.timeMs;
      if(this.adaptive && this.strategy==='liquidity') {
        this.outcomes.push(net); this.outcomes=this.outcomes.slice(-100); this.reviewsSince++;
        if(this.reviewsSince>=20) {
          const next=learningDecision(this.outcomes,this.riskLevel);
          if(this.learningEnabled && next.level!==this.riskLevel) {
            this.changes.push({id:this.nextClosed,timeMs:this.timeMs,from:this.riskLevel,to:next.level,meanNet:next.meanNet,winRate:next.winRate,reason:next.level>this.riskLevel?'Negative net expectancy: stricter flow filter and longer cooldown':'Positive net expectancy: relax one step within baseline limits'});
            this.riskLevel=next.level; this.changes=this.changes.slice(-100);
          }
          this.reviewsSince=0;
        }
      }
    }
    this.event(3, order, responseMs, order.createdMs, exchangeMs, qty);
    this.log(`Fill ${order.side.toUpperCase()} ${qty} @ ${price.toFixed(2)}; fee $${fee.toFixed(2)}.`);
  }

  #checkRisk(): void {
    this.#orderSafety?.checkRisk(this.exchangePosition, this.cash + this.position * this.markPrice * POINT_VALUE, MAX_POSITION);
  }

  #canRoute(): boolean {
    return !this.#retired && (this.#orderSafety?.allowOrder() ?? true);
  }

  // Every simulated entry and exit reaches the exchange through this method.
  #submit(order: SimulationOrder): boolean {
    if (!this.#canRoute()) return false;
    this.orders.push(order);
    this.submits++;
    this.event(1, order, this.timeMs, this.timeMs, NaN);
    return true;
  }

  private requote(frame: SimulationFrame, force = false): void {
    this.advanceOrders();
    this.#checkRisk();
    if (!this.#canRoute()) {
      this.block();
      return;
    }
    if (!this.validBook(frame)) {
      this.discardQuotes("Two-sided non-crossed quotes unavailable; quoting suspended.");
      return;
    }
    if (this.strategy === "liquidity") { this.quoteLiquidity(frame, force); return; }
    if (!force && this.timeMs - this.lastQuoteMs < QUOTE_INTERVAL_MS) return;
    this.lastQuoteMs = this.timeMs;
    for (const side of ["buy", "sell"] as const) {
      const direction = side === "buy" ? 1 : -1;
      const level = side === "buy" ? frame.bids[0] : frame.asks[0];
      const current = this.orders.find((order) => order.side === side && working(order));
      const permitted = direction * this.position < MAX_POSITION;
      if (current) {
        if ((!permitted || current.price !== level[0]) && current.cancelMs === null) {
          this.requestCancel(current);
          this.log(`${current.id} cancel requested; variable modeled delay.`);
        }
        continue; // Wait until the modeled cancellation is effective before replacing.
      }
      if (!permitted) continue;
      const ahead = Math.max(0, Math.floor(level[1]));
      const order: SimulationOrder = { id: `SIM-${this.nextOrder++}`, side, price: level[0], qty: 1, remaining: 1,
        ahead, initialAhead: ahead, state: "pending", createdMs: this.timeMs, activeMs: this.timeMs + ENTRY_MS, cancelMs: null,
        acknowledged: false, tradedQuantity: 0, reason: "MM" };
      if (!this.#submit(order)) return;
      this.log(`${order.id} ${side.toUpperCase()} 1 @ ${order.price.toFixed(2)}; assumed queue ahead ${ahead}.`);
    }
  }

  private protectPosition(tickSize: number): void {
    if (this.strategy !== "liquidity" || !this.position || this.orders.some(o => o.market && working(o))) return;
    const adverse = Math.sign(this.position) * (this.averageEntry - this.markPrice) / tickSize;
    if (adverse < this.stopTicks && this.timeMs - this.positionSince < 60000) return;
    for (const order of this.orders) if (working(order) && order.cancelMs === null) {
      this.requestCancel(order);
    }
    const order: SimulationOrder = { id: `SIM-${this.nextOrder++}`, side: this.position > 0 ? "sell" : "buy",
      price: this.markPrice, qty: Math.abs(this.position), remaining: Math.abs(this.position), ahead: 0, initialAhead: 0,
      state: "pending", createdMs: this.timeMs, activeMs: this.timeMs + ENTRY_MS, cancelMs: null, reason: adverse >= this.stopTicks ? "STOP" : "TIME", role: "exit", market: true, acknowledged: false, tradedQuantity: 0 };
    if (!this.#submit(order)) return;
    this.decision = adverse >= this.stopTicks ? `Protective exit: ${this.stopTicks}-tick stop` : "Protective exit: 60-second hold limit";
    this.log(`${this.decision}; next sampled print after ${order.entryLatencyMs} ms, plus one adverse tick. Gaps can increase loss.`);
  }

  private quoteLiquidity(frame: SimulationFrame, force: boolean): void {
    if (this.orders.some(o => o.market && working(o))) return;
    if (!force && this.timeMs - this.lastQuoteMs < 3000) return;
    this.lastQuoteMs = this.timeMs;
    const mid = (frame.bids[0][0] + frame.asks[0][0]) / 2;
    if(this.adaptive) this.updateSignal(frame);
    this.neural=this.learningEnabled&&!frame.replay&&this.signal.warmed?this.predictor?.(this.signal,this.timeMs)??null:null;
    const canEnter=!this.adaptive || (this.signal.warmed && this.signal.spreadTicks<=4 && this.signal.rangeTicks<=48 && this.timeMs-this.lastClosedMs>=this.cooldownMs);
    const maxQueues=this.adaptive?Math.max(1,this.levels-this.riskLevel):this.levels;
    // Six ticks between entry sides exceeds the assumed three-tick round-trip fee.
    // Use only actual published depth levels. Missing depth never becomes a fake wall.
    const desired: { side: Side; price: number; ahead: number; role: "demand" | "supply" | "exit" }[] = [];
    for (const side of ["buy", "sell"] as const) {
      const direction = side === "buy" ? 1 : -1;
      if (direction * this.position >= MAX_POSITION) continue;
      const closing = direction * this.position < 0;
      if (!closing && (!canEnter || (this.adaptive && (direction*this.signal.flow<this.minFlow || direction*this.signal.depth<.08 || direction*this.signal.momentumTicks < -2)))) continue;
      if(!closing&&this.neural&&this.neural[side]<.6)continue;
      const levels = side === "buy" ? frame.bids : frame.asks;
      const candidates = levels.filter(([price, qty]) => finite(price) && finite(qty) && qty >= 1
        && Math.abs(price / frame.tickSize - Math.round(price / frame.tickSize)) < 1e-5
        && (side === "buy" ? price <= frame.bids[0][0] : price >= frame.asks[0][0])
        && (closing || !this.adaptive || this.timeMs-(this.stableLevels.get(side+':'+price)??this.timeMs)>=1000)
        && (closing ? direction * (this.averageEntry - price) >= this.targetTicks * frame.tickSize
          : direction * (mid - price) >= 3 * frame.tickSize && Math.abs(price - mid) <= 32 * frame.tickSize));
      candidates.sort((a, b) => closing ? direction * (b[0] - a[0])
        : b[1] / (1 + Math.abs(b[0] - mid) / frame.tickSize / 8) - a[1] / (1 + Math.abs(a[0] - mid) / frame.tickSize / 8));
      const chosen: number[] = [];
      for (const [price, qty] of candidates) {
        if (chosen.some(p => Math.abs(p - price) < 2 * frame.tickSize)) continue;
        desired.push({ side, price, ahead: Math.floor(qty), role: closing ? "exit" : side === "buy" ? "demand" : "supply" });
        chosen.push(price);
        if (chosen.length >= (closing ? 1 : maxQueues)) break;
      }
    }
    for (const order of this.orders) if (working(order) && order.cancelMs === null
      && !desired.some(d => d.side === order.side && d.price === order.price)) {
      this.requestCancel(order);
    }
    for (const d of desired) {
      // Cancellation has to complete before a slot or a price can be reused.
      const sameSide = this.orders.filter(o => o.side === d.side && working(o));
      if (sameSide.some(o => o.price === d.price) || sameSide.length >= (this.position ? 1 : maxQueues)) continue;
      const order: SimulationOrder = { id: `SIM-${this.nextOrder++}`, side: d.side, price: d.price, qty: 1, remaining: 1,
        ahead: d.ahead, initialAhead: d.ahead, state: "pending", createdMs: this.timeMs,
        activeMs: this.timeMs + ENTRY_MS, cancelMs: null, reason: d.role === "demand" ? "DMD" : d.role === "supply" ? "SUP" : "TP", role: d.role, acknowledged: false, tradedQuantity: 0 };
      if (!this.#submit(order)) return;
      this.log(`${d.role.toUpperCase()} ${d.side.toUpperCase()} 1 @ ${d.price.toFixed(2)}; estimated ahead ${d.ahead}.`);
    }
    this.decision = this.position ? `Managing inventory: ${this.targetTicks}-tick target / ${this.stopTicks}-tick stop`
      : desired.length ? 'Confirmed flow + persistent depth: queued entries'
      : this.adaptive ? !this.signal.warmed?'Warming up: need 20 prints over 10 seconds':this.timeMs-this.lastClosedMs<this.cooldownMs?'Cooldown after closed trade':this.signal.spreadTicks>4?'Waiting: spread exceeds 4 ticks':this.signal.rangeTicks>48?'Waiting: 20-second range exceeds 48 ticks':'Waiting for aligned flow, depth and stable levels'
      : 'Waiting for depth beyond the fee buffer';
    if (this.diagEnabled) this.captureDecision(frame, desired);
  }

  /**
   * Read-only gate diagnostics for the decision just made. Evaluates every
   * entry gate INDEPENDENTLY (actual value, threshold, pass/fail) so the
   * report can separate the engine's first rejection reason from all
   * simultaneously failing conditions. Pushes one record to diagLog; does
   * not read or write any trading state. The candidate predicate mirrors
   * quoteLiquidity's level filter for flat entries (band + stability).
   */
  private captureDecision(frame: SimulationFrame, desired: { side: Side; price: number; ahead: number; role: "demand" | "supply" | "exit" }[]): void {
    if (!this.adaptive) return;
    const sig = this.signal;
    const firstBucketMs = this.recentTrades[0]?.timeMs ?? this.timeMs;
    const sinceCloseMs = this.timeMs - this.lastClosedMs;
    const mid = (frame.bids[0][0] + frame.asks[0][0]) / 2;
    const gates: GateRecord[] = [
      { name: "warmup", value: { prints: sig.prints, spanMs: Math.round(this.timeMs - firstBucketMs) }, threshold: null, pass: sig.warmed, note: "needs >=20 prints over >=10 s of tape" },
      { name: "spread", value: sig.spreadTicks, threshold: 4, pass: sig.spreadTicks <= 4 },
      { name: "range20s", value: sig.rangeTicks, threshold: 48, pass: sig.rangeTicks <= 48 },
      { name: "cooldown", value: Math.round(sinceCloseMs), threshold: this.cooldownMs, pass: sinceCloseMs >= this.cooldownMs },
      { name: "positionLimit", value: Math.abs(this.position), threshold: 1, pass: Math.abs(this.position) < 1 },
    ];
    const failing: string[] = [];
    const mark = (g: GateRecord) => { if (!g.pass) failing.push(g.name); };
    gates.forEach(mark);
    for (const [side, dir] of [["buy", 1], ["sell", -1]] as [Side, number][]) {
      const flow: GateRecord = { name: `flow.${side}`, value: dir * sig.flow, threshold: this.minFlow, pass: dir * sig.flow >= this.minFlow };
      const depth: GateRecord = { name: `depth.${side}`, value: dir * sig.depth, threshold: 0.08, pass: dir * sig.depth >= 0.08 };
      const mom: GateRecord = { name: `momentum.${side}`, value: dir * sig.momentumTicks, threshold: -2, pass: dir * sig.momentumTicks >= -2 };
      const levels = side === "buy" ? frame.bids : frame.asks;
      let candidates = 0;
      for (const [price, qty] of levels) {
        if (!finite(price) || !finite(qty) || qty < 1) continue;
        if (Math.abs(price / frame.tickSize - Math.round(price / frame.tickSize)) >= 1e-5) continue;
        if (side === "buy" ? price > frame.bids[0][0] : price < frame.asks[0][0]) continue;
        if (this.timeMs - (this.stableLevels.get(side + ":" + price) ?? this.timeMs) < 1000) continue;
        if (dir * (mid - price) < 3 * frame.tickSize || Math.abs(price - mid) > 32 * frame.tickSize) continue;
        candidates++;
      }
      const stable: GateRecord = { name: `stableCandidates.${side}`, value: candidates, threshold: 1, pass: candidates >= 1, note: "level >=1 s old inside the 3-32t band" };
      gates.push(flow, depth, mom, stable);
      mark(flow); mark(depth); mark(mom); mark(stable);
    }
    gates.push({ name: "neural", value: null, threshold: null, pass: true, note: "disabled in replay (predictor not installed)" });
    const byName = new Map(gates.map((g) => [g.name, g.pass]));
    const globalPass = Boolean(byName.get("warmup") && byName.get("spread") && byName.get("range20s") && byName.get("cooldown"));
    const sideOk = (s: Side) => Boolean(byName.get(`flow.${s}`) && byName.get(`depth.${s}`) && byName.get(`momentum.${s}`) && byName.get(`stableCandidates.${s}`));
    this.diagLog.push({
      t: this.timeMs,
      position: this.position,
      riskLevel: this.riskLevel,
      firstReason: this.decision,
      gates,
      failingGates: failing,
      jointPassAnySide: globalPass && (sideOk("buy") || sideOk("sell")),
      candidatePrices: { buy: desired.filter((d) => d.side === "buy").map((d) => d.price), sell: desired.filter((d) => d.side === "sell").map((d) => d.price) },
      neural: "null",
    });
  }

  private updateSignal(frame: SimulationFrame): void {
    const t=this.recentTrades, volume=t.reduce((n,t)=>n+t.buyVolume+t.sellVolume,0),prints=t.reduce((n,t)=>n+t.prints,0);
    const bid=frame.bids.slice(0,5).reduce((n,l)=>n+l[1],0), ask=frame.asks.slice(0,5).reduce((n,l)=>n+l[1],0);
    this.signal={flow:volume?t.reduce((n,t)=>n+t.buyVolume-t.sellVolume,0)/volume:0,depth:(bid+ask)?(bid-ask)/(bid+ask):0,
      momentumTicks:t.length?(t.at(-1)!.lastPrice-t[0].price)/frame.tickSize:0,rangeTicks:t.length?(Math.max(...t.map(t=>t.high))-Math.min(...t.map(t=>t.low)))/frame.tickSize:0,
      spreadTicks:(frame.asks[0][0]-frame.bids[0][0])/frame.tickSize,prints,warmed:prints>=20&&this.timeMs-t[0].timeMs>=10000};
    const next=new Map<string,number>();
    for(const [side,levels] of [['buy',frame.bids],['sell',frame.asks]] as const) {
      const sizes=levels.slice(0,20).map(l=>l[1]).sort((a,b)=>a-b), median=sizes[Math.floor(sizes.length/2)]??0;
      for(const [price,qty] of levels) if(qty>=Math.max(2,median*1.25)) {const key=side+':'+price;next.set(key,this.stableLevels.get(key)??this.timeMs);}
    }
    this.stableLevels=next;
  }
  private responseDelay(order:SimulationOrder,phase:number): number {
    return this.latencyMode==='constant'?RESPONSE_MS:modeledDelay(this.timeMs+Number(order.id.slice(4))*7919,phase);
  }
  private requestCancel(order:SimulationOrder): void {
    const delay=this.latencyMode==='constant'?ENTRY_MS:modeledDelay(this.timeMs+Number(order.id.slice(4))*7919,4);
    order.cancelRequestMs=this.timeMs;order.cancelMs=this.timeMs+delay;order.cancelResponseMs=this.responseDelay(order,5);order.state='canceling';
    const at=order.cancelMs,request=this.timeMs,due=at+order.cancelResponseMs;
    this.respond(at,()=>{
      const ex=this.exchange.get(order.id);
      if(!ex||ex.state!=='working')return; // a fill won the exchange-side race
      ex.state='canceled';
      this.respond(due,()=>{
        if(order.state==='canceled')return;
        order.state='canceled';this.cancels++;
        this.event(5,order,due,request,at);
        this.log(order.id+' cancellation received.');
      });
    });
    this.event(4,order,this.timeMs,this.timeMs,NaN);
  }
  outstandingOrderIds(): string[] {
    return this.orders.filter(order => working(order) && this.exchange.get(order.id)?.state !== 'filled')
      .map(order => order.id);
  }

  cancelOrder(orderId: string): boolean {
    const order = this.orders.find(candidate => candidate.id === orderId);
    if (!order || !working(order)) return false;
    const exchangeOrder = this.exchange.get(orderId);
    // An executed fill must still reach the paper account on its response.
    if (exchangeOrder?.state === 'filled') return false;
    if (exchangeOrder) exchangeOrder.state = 'canceled';
    order.state = "canceled";
    order.cancelMs = this.timeMs;
    this.cancels++;
    this.event(5, order, this.timeMs, this.timeMs, NaN);
    return true;
  }

  private discardQuotes(reason: string): void {
    const orders = this.outstandingOrderIds();
    for (const orderId of orders) this.cancelOrder(orderId);
    if (orders.length) this.log(reason);
  }

  private log(message: string): void {
    this.logs.push({ timeMs: this.timeMs, message });
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
  }

  private event(kind: SimulationEvent["kind"], order: SimulationOrder, timeMs: number, requestMs: number, exchangeMs: number, qty = order.qty): void {
    if(kind===1) {
      const key=this.timeMs+Number(order.id.slice(4))*7919;
      order.entryLatencyMs=this.latencyMode==='constant'?ENTRY_MS:modeledDelay(key,1);
      order.responseLatencyMs=this.latencyMode==='constant'?RESPONSE_MS:modeledDelay(key,2);
      order.activeMs=this.timeMs+order.entryLatencyMs;
      this.exchange.set(order.id,{remaining:order.qty,state:'working'});
      const due=order.activeMs+order.responseLatencyMs;
      this.respond(due,()=>{
        if (order.state === 'canceled'
          || (this.status === 'blocked' && this.exchange.get(order.id)?.state !== 'filled')) return;
        order.acknowledged=true;if(order.state==='pending')order.state='working';
        this.event(2,order,due,order.createdMs,order.activeMs);
      });
    }
    this.events.push({ sequence:this.nextEvent++, kind, orderId: order.id, side: order.side, price: order.price, qty, timeMs, requestMs, exchangeMs,
      reason: order.reason, market: order.market, ahead: kind === 2 ? order.initialAhead : order.ahead, level: order.initialAhead + order.qty, tradedQuantity: order.tradedQuantity });
    // Keep complete recent lifecycles so the shared replay panels can derive
    // fills and queue statistics without an unbounded browser session.
    if (this.events.length > 12000) {
      const retainedIds = new Set(this.events.slice(-8000).map(event => event.orderId));
      for (const current of this.orders) if (working(current)) retainedIds.add(current.id);
      this.events = this.events.filter(event => retainedIds.has(event.orderId));
    }
  }

  private trim(): void {
    this.orders = this.orders.filter((order, index) => working(order) || index >= this.orders.length - 40);
    const retained=new Set(this.orders.map(o=>o.id));for(const id of this.exchange.keys())if(!retained.has(id))this.exchange.delete(id);
    if (this.fills.length > 100) this.fills.splice(0, this.fills.length - 100);
  }
}

