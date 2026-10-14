import {fileURLToPath} from 'node:url';
import {resolve,isAbsolute} from 'node:path';
export const stateRoot=process.env.XMR20_STATE_DIR||fileURLToPath(new URL('../state/',import.meta.url));
if(!isAbsolute(stateRoot))throw Error('STATE_PATH');
export const statePath=name=>{if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw Error('STATE_PATH');return resolve(stateRoot,name);};
