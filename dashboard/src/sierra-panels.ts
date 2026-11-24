import { esc, sp } from './dom';
import type { Session } from './session';
import type { SierraAccount } from './sierra-account';
const time = (ms: number) => ms > 0 ? new Date(ms).toISOString().slice(11, 23) : '—';
export function sierraPanel(s: Session, key: string): {
    html: string;
    title: string;
} | null {
    if (!s.meta.live?.followSierra)
        return null;
    const a = s.meta.live.sierraAccount as SierraAccount | null;
    if (!a?.simulation)
        return { html: sp('y', 'Waiting for Sierra simulation account data.'), title: 'SIERRA ACCOUNT' };
    const source = sp('c', `SIERRA ${esc(a.account)} · account records`), out = [source];
    if (key === 'fills') {
        out.push(sp('d', 'TIME         SIDE  PRICE       QTY  ORDER'));
        for (const f of a.fills.slice().reverse())
            out.push(`${time(f.timeMs)} ${sp(f.side === 'buy' ? 'bid' : 'ask', f.side.toUpperCase().padEnd(5))} ${f.price.toFixed(2).padStart(9)} ${String(f.quantity).padStart(4)}  #${f.orderId}`);
        if (!a.fills.length)
            out.push('No Sierra fills loaded.');
        out.push('', sp('d', 'Exchange queue-at-fill and split latency unavailable.'));
        return { html: out.join('\n'), title: `${a.fills.length} Sierra fills` };
    }
    if (key === 'queue') {
        out.push(sp('d', 'SIDE  PRICE       LEFT  QUEUE*  ORDER'));
        const orders = a.orders.filter(o => o.working);
        for (const o of orders)
            out.push(`${sp(o.side === 'buy' ? 'bid' : 'ask', o.side.toUpperCase().padEnd(5))} ${o.price.toFixed(2).padStart(9)} ${String(o.quantity - o.filled).padStart(5)} ${String(o.queueEstimate ?? '—').padStart(7)} #${o.id}\n${sp('d', esc(`${o.role} · ${o.status}`))}`);
        if (!orders.length)
            out.push('No working Sierra orders.');
        out.push('', sp('d', '* Sierra estimate when reported; not exchange rank.'), sp('d', '— means unavailable. No synthetic queue is substituted.'));
        return { html: out.join('\n'), title: `${orders.length} Sierra working` };
    }
    if (key === 'log') {
        for (const o of a.orders.slice().sort((x, y) => y.updatedMs - x.updatedMs))
            out.push(`${time(o.updatedMs)} ${sp(o.side === 'buy' ? 'bid' : 'ask', o.side.toUpperCase())} #${o.id} ${o.quantity} @ ${o.price.toFixed(2)} ${esc(o.status)} filled ${o.filled}`);
        for (const f of a.fills.slice().reverse())
            out.push(`${time(f.timeMs)} ${sp('y', 'FILL')} ${f.side.toUpperCase()} #${f.orderId} ${f.quantity} @ ${f.price.toFixed(2)}`);
        out.push('', sp('d', 'Sierra status snapshots and recorded fills.'), sp('d', 'Not a reconstructed submit/ack message trace.'));
        return { html: out.join('\n'), title: 'Sierra order records' };
    }
    return null;
}
