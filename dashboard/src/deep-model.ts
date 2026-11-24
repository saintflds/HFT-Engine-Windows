import type { SignalState } from './replay-simulation';
type Layer = {
    w: number[][];
    b: number[];
};
type Model = {
    version: string;
    symbol: string;
    qualified: boolean;
    trainedMs: number;
    layers: Layer[];
};
export type DeepState = {
    samples: number;
    minimum: number;
    training: boolean;
    status: string;
    error: string;
    model: Model | null;
    evaluation?: any;
};
export class DeepModel {
    state: DeepState = { samples: 0, minimum: 600, training: false, status: 'Connecting', error: '', model: null };
    async refresh() { try {
        const r = await fetch('/api/mnq/deep', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!r.ok)
            throw Error('Model service unavailable');
        this.state = await r.json();
    }
    catch (e) {
        this.state = { ...this.state, model: null, status: 'Unavailable', error: String(e) };
    } }
    predict(s: SignalState, timeMs: number) {
        const m = this.state.model;
        // Never apply a model trained after the current source time (including replay).
        if (!m?.qualified || m.version !== 'mnq-deep-v1' || m.symbol !== 'MNQZ26-CME' || m.trainedMs > timeMs || Date.now() - m.trainedMs > 7 * 86400000)
            return null;
        let x = [s.flow, s.depth, s.momentumTicks / 32, s.rangeTicks / 48, s.spreadTicks / 4, Math.log1p(s.prints) / 7].map(v => Math.max(-5, Math.min(5, v)));
        for (let l = 0; l < m.layers.length; l++) {
            const layer = m.layers[l];
            let z = layer.w.map((row, j) => row.reduce((sum, v, k) => sum + v * x[k], layer.b[j]));
            if (l < 2)
                z = z.map(v => Math.max(0, v));
            else {
                const max = Math.max(...z);
                z = z.map(v => Math.exp(v - max));
                const total = z.reduce((a, b) => a + b, 0);
                z = z.map(v => v / total);
            }
            x = z;
        }
        return x.length === 3 && x.every(Number.isFinite) ? { sell: x[0], flat: x[1], buy: x[2] } : null;
    }
}
