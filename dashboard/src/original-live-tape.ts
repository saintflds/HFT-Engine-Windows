/** Keeps sampled Sierra trades within one symbol, feed mode and replay timeline. */
export type MarketTrade = {
  sequence: number;
  timeMs: number;
  price: number;
  quantity: number;
  side: "buy" | "sell";
};

type TapeSnapshot = {
  symbol: string;
  replay: boolean;
  publishedMs: number;
  trades: readonly MarketTrade[];
};

export class ReplaySafeTape {
  private readonly trades = new Map<number, MarketTrade>();
  private source: Omit<TapeSnapshot, "trades"> | null = null;
  // Keep these across empty frames: the next frame can reveal a replay rewind.
  private lastSequence: number | null = null;
  private lastTradeTime: number | null = null;

  get size(): number { return this.trades.size; }

  accept(frame: TapeSnapshot): void {
    if (this.source && (this.source.symbol !== frame.symbol || this.source.replay !== frame.replay
      || frame.publishedMs < this.source.publishedMs)) this.reset();

    if (!frame.trades.length) {
      // Sierra can clear its tape while seeking/reloading a replay. Drop the old
      // displayed timeline immediately, before its replacement trades arrive.
      if (frame.replay) this.trades.clear();
    } else {
      const sequence = Math.max(...frame.trades.map((trade) => trade.sequence));
      const tradeTime = Math.max(...frame.trades.map((trade) => trade.timeMs));
      if ((this.lastSequence !== null && sequence < this.lastSequence)
        || (this.lastTradeTime !== null && tradeTime < this.lastTradeTime)) this.reset();

      for (const trade of frame.trades) this.trades.set(trade.sequence, trade);
      this.lastSequence = sequence;
      this.lastTradeTime = tradeTime;
      if (this.trades.size > 1000) {
        const retained = this.recent(1000);
        this.trades.clear();
        for (const trade of retained) this.trades.set(trade.sequence, trade);
      }
    }
    this.source = { symbol: frame.symbol, replay: frame.replay, publishedMs: frame.publishedMs };
  }

  recent(limit: number): MarketTrade[] {
    return [...this.trades.values()].sort((a, b) => b.timeMs - a.timeMs || b.sequence - a.sequence).slice(0, Math.max(0, limit));
  }

  private reset(): void {
    this.trades.clear();
    this.lastSequence = null;
    this.lastTradeTime = null;
  }
}
