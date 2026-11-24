import { parentPort, workerData } from 'node:worker_threads';
import { train } from './deep-network.mjs';
try {
    parentPort.postMessage({ model: train(workerData) });
}
catch (e) {
    parentPort.postMessage({ error: e.message });
}
