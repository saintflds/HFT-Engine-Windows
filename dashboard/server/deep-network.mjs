// A trainable 6 -> 16 -> 8 -> 3 neural network. Two ReLU hidden layers,
// softmax output, cross-entropy backpropagation, deterministic initialization.
export const FEATURES = ['flow', 'depth', 'momentumTicks', 'rangeTicks', 'spreadTicks', 'prints'];
export const vector = s => [s.flow, s.depth, s.momentumTicks / 32, s.rangeTicks / 48, s.spreadTicks / 4, Math.log1p(s.prints) / 7].map(v => Math.max(-5, Math.min(5, v)));
export function network(seed = 42) { let state = seed; const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; return [6, 16, 8].map((n, l) => ({ w: Array.from({ length: [16, 8, 3][l] }, () => Array.from({ length: n }, () => (random() * 2 - 1) * Math.sqrt(6 / n))), b: Array([16, 8, 3][l]).fill(0) })); }
export function forward(layers, x) { const activations = [x]; for (let l = 0; l < layers.length; l++) {
    const { w, b } = layers[l];
    let z = w.map((row, j) => row.reduce((s, v, k) => s + v * activations[l][k], b[j]));
    if (l < layers.length - 1)
        z = z.map(v => Math.max(0, v));
    else {
        const max = Math.max(...z), exp = z.map(v => Math.exp(v - max)), sum = exp.reduce((a, b) => a + b, 0);
        z = exp.map(v => v / sum);
    }
    activations.push(z);
} return activations; }
export function step(layers, x, y, rate = .003) { const a = forward(layers, x); let delta = a.at(-1).map((p, i) => p - (i === y ? 1 : 0)); for (let l = layers.length - 1; l >= 0; l--) {
    const { w, b } = layers[l], prev = a[l];
    const back = prev.map((v, k) => v > 0 ? w.reduce((sum, row, j) => sum + row[k] * delta[j], 0) : 0);
    for (let j = 0; j < w.length; j++) {
        for (let k = 0; k < w[j].length; k++)
            w[j][k] -= rate * Math.max(-5, Math.min(5, delta[j] * prev[k] + .0001 * w[j][k]));
        b[j] -= rate * delta[j];
    }
    delta = back;
} }
export function metrics(layers, rows, baseline) { let loss = 0, baseLoss = 0, correct = 0, signals = 0, hits = 0, edge = 0; for (const r of rows) {
    const p = forward(layers, r.x).at(-1), best = p.indexOf(Math.max(...p));
    loss -= Math.log(Math.max(1e-9, p[r.y]));
    baseLoss -= Math.log(Math.max(1e-9, baseline[r.y]));
    correct += best === r.y ? 1 : 0;
    if (best !== 1 && p[best] >= .6) {
        signals++;
        hits += best === r.y ? 1 : 0;
        edge += (best === 2 ? 1 : -1) * r.moveTicks - r.costTicks;
    }
} return { count: rows.length, loss: loss / rows.length, baselineLoss: baseLoss / rows.length, accuracy: correct / rows.length, signals, precision: signals ? hits / signals : 0, forecastEdgeTicks: signals ? edge / signals : 0 }; }
export function chronologicalSplit(rows) { const a = Math.floor(rows.length * .7), b = Math.floor(rows.length * .85); return { train: rows.slice(0, a).filter(r => r.endMs < rows[a].startMs), validation: rows.slice(a, b).filter(r => r.endMs < rows[b].startMs), test: rows.slice(b) }; }
export function train(rows) {
    if (rows.length < 600)
        throw Error('Need 600 non-overlapping labeled observations');
    const { train: fit, validation, test } = chronologicalSplit(rows);
    const baseline = [0, 1, 2].map(k => (fit.filter(r => r.y === k).length + 1) / (fit.length + 3));
    let layers = network(), best = null, bestLoss = Infinity, bestEpoch = 0;
    for (let epoch = 0; epoch < 60; epoch++) {
        // Only the training split changes weights. Validation chooses the checkpoint.
        for (let i = 0; i < fit.length; i++) {
            const r = fit[(i + epoch * 97) % fit.length];
            step(layers, r.x, r.y, .003 / (1 + epoch * .03));
        }
        const score = metrics(layers, validation, baseline).loss;
        if (score < bestLoss) {
            bestLoss = score;
            best = structuredClone(layers);
            bestEpoch = epoch + 1;
        }
    }
    const v = metrics(best, validation, baseline), t = metrics(best, test, baseline);
    const qualified = [v, t].every(m => m.loss < m.baselineLoss * .98 && m.signals >= 20 && m.precision >= .55 && m.forecastEdgeTicks > 0);
    return { version: 'mnq-deep-v1', architecture: [6, 16, 8, 3], features: FEATURES, layers: best, qualified, trainedMs: Date.now(), lastEndMs: rows.at(-1).endMs, samples: rows.length, epochs: bestEpoch,
        validation: v, test: t, split: { training: fit.length, validation: validation.length, test: test.length, purged: rows.length - fit.length - validation.length - test.length },
        target: '10-second observed price move beyond fee/slippage allowance; not execution P&L', reason: qualified ? 'Passed chronological forecast checks' : 'Collecting: candidate did not pass forecast checks' };
}
