/**
 * 本机同步状态：上次同步的基线快照，以及设备标识。
 * 基线是三方比较的第三方，没有它就无法区分"对方改了"和"我删了"。
 */
const fs = require('node:fs');
const path = require('node:path');

const { randomId } = require('./util.js');

const STATE_DIR = '.webdav-chat-backup';
const STATE_FILE = 'sync-base.json';

function stateFilePath(directories) {
    return path.join(directories.root, STATE_DIR, STATE_FILE);
}

function readState(directories) {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFilePath(directories), 'utf8'));
        return {
            device: typeof parsed.device === 'string' ? parsed.device : '',
            base: parsed.base && typeof parsed.base === 'object' ? parsed.base : {},
            lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : '',
        };
    } catch {
        return { device: '', base: {}, lastSyncAt: '' };
    }
}

function writeState(directories, state) {
    const file = stateFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 用户填了名字就用用户的，否则沿用已有的，都没有才生成一个。 */
function resolveDevice(directories, preferred) {
    const state = readState(directories);
    if (preferred) {
        if (state.device !== preferred) {
            state.device = preferred;
            writeState(directories, state);
        }
        return preferred;
    }
    if (state.device) return state.device;
    state.device = `device-${randomId()}`;
    writeState(directories, state);
    return state.device;
}

module.exports = {
    STATE_DIR,
    readState,
    writeState,
    resolveDevice,
};
