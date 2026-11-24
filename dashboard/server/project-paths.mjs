import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const engineRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const projectRoot=path.dirname(engineRoot);
export const liveFile=path.join(engineRoot,'data/sierra/latest.json');
