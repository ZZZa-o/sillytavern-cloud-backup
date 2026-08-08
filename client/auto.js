/** 自动执行：定时与聊天事件触发，按设置跑增量同步或 zip 快照。 */
import { getSettings, DEFAULT_SETTINGS } from './settings.js';
import { isBusy } from './ui.js';
import { runSync } from './sync.js';
import { createSnapshot } from './snapshot.js';

const TICK_MS = 60 * 1000;
const EVENT_DEBOUNCE_MS = 5000;

let timer = null;
let debounce = null;

function intervalMs() {
    const hours = Math.max(0.25, Number(getSettings().autoIntervalHours) || DEFAULT_SETTINGS.autoIntervalHours);
    return hours * 60 * 60 * 1000;
}

/** 上次自动动作的时间，按当前模式取对应的时间戳。 */
function lastRunAt() {
    const s = getSettings();
    const value = s.autoMode === 'snapshot' ? s.lastBackupAt : s.lastSyncAt;
    return value ? new Date(value).getTime() : 0;
}

export async function maybeRun(reason) {
    const s = getSettings();
    if (!s.autoEnabled || isBusy() || !s.url) return;
    if (Date.now() - lastRunAt() < intervalMs()) return;
    if (s.autoMode === 'snapshot') await createSnapshot(reason);
    else await runSync(reason);
}

export function queue(reason) {
    const s = getSettings();
    if (!s.autoEnabled || !s.autoOnChatEvents) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => maybeRun(reason), EVENT_DEBOUNCE_MS);
}

export function syncTimer() {
    clearInterval(timer);
    timer = null;
    if (!getSettings().autoEnabled) return;
    timer = setInterval(() => maybeRun('auto'), TICK_MS);
}
