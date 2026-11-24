import { cssVar } from "./dom";
export type ChartPoint = { time: number; bid: number; ask: number };

/** Connected prices, a quiet spread band, tick-aligned axes and visible data gaps. */
export function drawMarketChart(canvas: HTMLCanvasElement, points: readonly ChartPoint[], width: number, height: number,
  tickSize: number, options: { end: number; windowMs?: number; gapMs?: number; fills?: readonly { time: number; price: number; side: string }[] }) {
  const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; canvas.style.imageRendering = "auto";
  const scale = Math.max(1, (window.devicePixelRatio || 1) * (canvas.getBoundingClientRect().width / w || 1));
  if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = cssVar("--black"); ctx.fillRect(0, 0, w, h);
  const span = options.windowMs ?? 60000, start = options.end - span;
  const data = points.filter(p => p.time >= start && p.time <= options.end && Number.isFinite(p.bid)
    && Number.isFinite(p.ask) && p.bid > 0 && p.ask >= p.bid);
  const left = 6, right = w - 65, top = 20, bottom = h - 23;
  ctx.font = "11px Consolas, monospace"; ctx.textBaseline = "middle";
  if (right <= left || bottom <= top) return;
  if (!data.length) { ctx.fillStyle = cssVar("--gray"); ctx.fillText("Waiting for price updates", left, top + 10); return; }
  let low = Math.min(...data.map(p => p.bid)), high = Math.max(...data.map(p => p.ask));
  const pad = Math.max(tickSize * 4, (high - low) * 0.12);
  low = Math.floor((low - pad) / tickSize) * tickSize;
  high = Math.ceil((high + pad) / tickSize) * tickSize;
  const x = (time: number) => left + (time - start) / span * (right - left);
  const y = (price: number) => bottom - (price - low) / (high - low) * (bottom - top);
  const steps = Math.max(2, Math.min(5, Math.floor((bottom - top) / 35)));
  const gridStep = Math.max(tickSize, Math.ceil((high - low) / steps / tickSize) * tickSize);
  for (let price = Math.ceil(low / gridStep) * gridStep; price <= high; price += gridStep) {
    const yy = y(price);
    ctx.strokeStyle = "rgba(170,170,255,0.18)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = cssVar("--gray"); ctx.fillText(price.toFixed(2), right + 5, yy);
  }
  ctx.fillStyle = cssVar("--gray");
  for (let i = 0; i <= 2; i++) {
    const time = start + span * i / 2, label = new Date(time).toISOString().slice(14, 19);
    ctx.fillText(label, Math.max(left, Math.min(right - 33, x(time) - 16)), h - 9);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  const groups: ChartPoint[][] = [];
  for (const p of data) {
    const group = groups.at(-1);
    if (!group || p.time - group.at(-1)!.time > (options.gapMs ?? 5000)) groups.push([p]); else group.push(p);
  }
  for (const group of groups) {
    ctx.fillStyle = "rgba(85,255,255,0.12)";
    ctx.beginPath(); group.forEach((p, i) => i ? ctx.lineTo(x(p.time), y(p.ask)) : ctx.moveTo(x(p.time), y(p.ask)));
    for (const p of group.slice().reverse()) ctx.lineTo(x(p.time), y(p.bid));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = cssVar("--white"); ctx.lineWidth = 1.5; ctx.lineJoin = "round";
    ctx.beginPath(); group.forEach((p, i) => i ? ctx.lineTo(x(p.time), y((p.bid + p.ask) / 2)) : ctx.moveTo(x(p.time), y((p.bid + p.ask) / 2)));
    ctx.stroke();
  }
  for (const fill of options.fills ?? []) if (fill.time >= start && fill.time <= options.end) {
    ctx.fillStyle = fill.side === "buy" ? cssVar("--green") : cssVar("--red");
    ctx.beginPath(); ctx.arc(x(fill.time), y(fill.price), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  const last = data.at(-1)!, mid = (last.bid + last.ask) / 2;
  ctx.fillStyle = cssVar("--yellow"); ctx.beginPath(); ctx.arc(x(last.time), y(mid), 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.fillStyle = cssVar("--white"); ctx.fillText(`MID ${mid.toFixed(2)}`, left, 9);
  ctx.fillStyle = cssVar("--gray"); if (w > 280) ctx.fillText("shade = bid / ask", left + 105, 9);
  canvas.setAttribute("aria-label", `Market mid price ${mid.toFixed(2)}; last ${span / 1000} seconds. Shaded area is bid to ask spread.`);
}
