/**
 * 同步的决策逻辑。这里全是纯函数，不碰网络也不碰磁盘，
 * 所以单元测试可以直接引入本模块，不需要 SillyTavern 的 node_modules。
 */
const { pathAllowed } = require('./paths.js');

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_PREVIEW_LIMIT = 40;

/**
 * 三方比较：本机、远端、上次同步基线。
 * 只有本机和远端都相对基线变化过，才算真冲突；只有一边变就直接同步过去。
 */
function buildPlan(context, direction = 'two-way') {
    const { local, remoteIndex, remotePresent, base, tombstones, include } = context;
    const plan = {
        upload: [],
        download: [],
        conflict: [],
        deleteLocal: [],
        deleteRemote: [],
        unchanged: 0,
        skipped: [],
    };

    const paths = new Set([
        ...Object.keys(local),
        ...Object.keys(remotePresent),
        ...Object.keys(base),
    ]);

    for (const relPath of paths) {
        if (!pathAllowed(relPath, include)) continue;

        const localHash = local[relPath]?.hash || null;
        const present = Object.prototype.hasOwnProperty.call(remotePresent, relPath);
        const indexed = remoteIndex[relPath]?.hash || null;
        const remoteHash = present ? indexed : null;
        const baseHash = base[relPath]?.hash || null;
        const tomb = tombstones[relPath];

        // 远端有文件但索引里没有哈希：手动上传，或索引损坏
        if (present && !indexed) {
            if (localHash) plan.conflict.push({ path: relPath, reason: 'remote-unindexed' });
            else plan.download.push({ path: relPath, reason: 'remote-unindexed' });
            continue;
        }

        if (localHash && remoteHash) {
            if (localHash === remoteHash) {
                plan.unchanged++;
            } else if (baseHash && baseHash === localHash) {
                plan.download.push({ path: relPath, reason: 'remote-changed' });
            } else if (baseHash && baseHash === remoteHash) {
                plan.upload.push({ path: relPath, reason: 'local-changed' });
            } else {
                plan.conflict.push({ path: relPath, reason: 'diverged' });
            }
            continue;
        }

        if (localHash && !remoteHash) {
            if (tomb && tomb.hash === localHash) {
                plan.deleteLocal.push({ path: relPath, reason: 'tombstone' });
            } else if (!tomb && baseHash && baseHash === localHash) {
                plan.deleteLocal.push({ path: relPath, reason: 'remote-deleted' });
            } else {
                // 本地在远端删除之后又改过，视为重新添加
                plan.upload.push({ path: relPath, reason: baseHash ? 'local-readded' : 'local-new' });
            }
            continue;
        }

        if (!localHash && remoteHash) {
            if (baseHash && baseHash === remoteHash) {
                plan.deleteRemote.push({ path: relPath, reason: 'local-deleted' });
            } else {
                plan.download.push({ path: relPath, reason: 'remote-new' });
            }
        }
        // 两边都没有：交给 applyPlan 从基线里清掉
    }

    return applyDirection(plan, direction);
}

function applyDirection(plan, direction) {
    if (direction === 'upload-only') {
        plan.skipped.push(...plan.download, ...plan.deleteLocal);
        plan.download = [];
        plan.deleteLocal = [];
        plan.conflict = plan.conflict.map(item => ({ ...item, resolution: 'force-upload' }));
    } else if (direction === 'download-only') {
        plan.skipped.push(...plan.upload, ...plan.deleteRemote);
        plan.upload = [];
        plan.deleteRemote = [];
        plan.conflict = plan.conflict.map(item => ({ ...item, resolution: 'force-download' }));
    }
    return plan;
}

const PLAN_ACTIONS = ['upload', 'download', 'conflict', 'deleteLocal', 'deleteRemote'];

/** 压成前端可直接渲染的结构，长列表截断以免响应过大。 */
function summarizePlan(plan) {
    const summary = {
        counts: { unchanged: plan.unchanged, skipped: plan.skipped.length },
        truncated: false,
    };
    for (const action of PLAN_ACTIONS) {
        const items = plan[action];
        summary.counts[action] = items.length;
        summary[action] = items.slice(0, PLAN_PREVIEW_LIMIT)
            .map(item => ({ path: item.path, reason: item.reason }));
        if (items.length > PLAN_PREVIEW_LIMIT) summary.truncated = true;
    }
    return summary;
}

function planTotal(plan) {
    return PLAN_ACTIONS.reduce((sum, action) => sum + plan[action].length, 0);
}

function splitJsonlLines(buffer) {
    return buffer.toString('utf8').split('\n').filter(line => line.trim().length > 0);
}

/**
 * SillyTavern 的聊天是逐行追加的 .jsonl，所以可以像 git 那样判断快进：
 * 若一方是另一方的行前缀，直接取更长的那份，不必当成冲突。
 * 改写已有消息（含 swipes）会让公共前缀提前中断，此时保守地判为分叉 ——
 * 宁可多留一个分支，也不要悄悄丢内容。
 */
function analyzeJsonl(localBuffer, remoteBuffer) {
    const localLines = splitJsonlLines(localBuffer);
    const remoteLines = splitJsonlLines(remoteBuffer);
    let common = 0;
    while (common < localLines.length
        && common < remoteLines.length
        && localLines[common] === remoteLines[common]) {
        common++;
    }
    if (common === localLines.length && common === remoteLines.length) return { type: 'same', common };
    if (common === localLines.length) return { type: 'fast-forward-download', common };
    if (common === remoteLines.length) return { type: 'fast-forward-upload', common };
    return { type: 'diverged', common };
}

function pruneTombstones(tombstones, now = Date.now()) {
    const cutoff = now - TOMBSTONE_TTL_MS;
    for (const [key, value] of Object.entries(tombstones)) {
        const at = new Date(value?.at || 0).getTime();
        if (!Number.isFinite(at) || at < cutoff) delete tombstones[key];
    }
    return tombstones;
}

module.exports = {
    TOMBSTONE_TTL_MS,
    PLAN_ACTIONS,
    buildPlan,
    summarizePlan,
    planTotal,
    analyzeJsonl,
    pruneTombstones,
};
