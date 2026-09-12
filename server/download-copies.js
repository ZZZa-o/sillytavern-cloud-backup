/** 手动下载保留副本：分配文件名，并保持角色、聊天、人设头像及配置引用一致。 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const paths = require('./paths.js');
const synthetic = require('./synthetic.js');

function uniqueName(name, taken) {
    let candidate = name;
    for (let n = 1; taken(candidate); n++) candidate = `${name}（${n}）`;
    return candidate;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function parseObject(buffer) {
    const data = JSON.parse(buffer.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('云端文件内容不是合法的 JSON 对象');
    }
    return data;
}

const jsonBuffer = data => Buffer.from(JSON.stringify(data, null, 4), 'utf8');
const isCard = entry => /^characters\/[^/]+$/.test(entry.local);
const isAvatar = entry => /^User Avatars\/[^/]+$/.test(entry.local);
const personaFolder = entry => entry.remote.split('/').slice(0, 2).join('/');

function priority(entry) {
    if (isCard(entry)) return 0;
    if (isAvatar(entry)) return 1;
    if (synthetic.isSynthetic(entry.local)) return 3;
    if (entry.local.startsWith('groups/')) return 4;
    return 2;
}

/** 先分配整批目标；先写角色与头像，再写依赖它们的内容。 */
function createCopyPlan(directories, entries) {
    const ordered = [...entries].sort((a, b) => priority(a) - priority(b));
    const reserved = new Set();
    const cards = new Map(entries.filter(isCard).map(entry => [
        paths.stemOf(path.posix.basename(entry.remote)), entry,
    ]));
    const avatars = new Map(entries.filter(isAvatar).map(entry => [
        `${personaFolder(entry)}\0${path.posix.basename(entry.local)}`, entry,
    ]));
    const byLocal = new Map(entries.map(entry => [entry.local, entry]));
    const secretCopies = new Map();
    const proxyCopies = new Map();

    function absolute(local) {
        const file = paths.localAbsPath(directories, local);
        if (!file) throw new Error(`无法解析本地路径：${local}`);
        return file;
    }

    const keyOf = file => process.platform === 'win32' ? file.toLowerCase() : file;
    const taken = local => {
        const file = absolute(local);
        return reserved.has(keyOf(file)) || fs.existsSync(file);
    };
    const reserve = local => reserved.add(keyOf(absolute(local)));
    const settings = () => readJson(path.join(directories.root, synthetic.SETTINGS_FILE));

    function allocate(local, card = false) {
        const ext = path.posix.extname(local);
        const base = local.slice(0, ext ? -ext.length : undefined);
        const power = local.startsWith('User Avatars/') ? settings().power_user : null;
        const candidate = uniqueName(base, name => {
            if (taken(`${name}${ext}`)) return true;
            if (card && (taken(name) || taken(`chats/${path.posix.basename(name)}`))) return true;
            const avatar = path.posix.basename(`${name}${ext}`);
            return !!power && (Object.hasOwn(power.personas || {}, avatar)
                || Object.hasOwn(power.persona_descriptions || {}, avatar));
        });
        const target = `${candidate}${ext}`;
        reserve(target);
        if (card) {
            reserve(candidate);
            reserve(`chats/${path.posix.basename(candidate)}`);
        }
        return target;
    }

    function characterParent(entry) {
        const local = entry.local.split('/');
        const remote = entry.remote.split('/');
        if (local.length < 3 || !['characters', 'chats'].includes(local[0])) return null;
        return cards.get(remote[1]);
    }

    function requireComplete(entry, label) {
        if (entry && !entry.complete) throw new Error(`${label}下载失败，未导入关联文件`);
    }

    for (const entry of ordered) {
        try {
            entry.parent = characterParent(entry);
            let local = entry.local;
            if (entry.parent) {
                if (entry.parent.error) throw new Error('角色卡无法另存，未导入关联文件');
                const parts = local.split('/');
                parts[1] = paths.stemOf(path.posix.basename(entry.parent.target));
                local = parts.join('/');
            }
            entry.target = synthetic.isSynthetic(local) ? local : allocate(local, isCard(entry));
        } catch (error) {
            entry.error = error.message;
        }
    }

    function preparePersona(entry, buffer) {
        const data = parseObject(buffer);
        const avatar = typeof data.avatar === 'string' ? data.avatar.trim() : '';
        if (!avatar || /[\\/]/.test(avatar) || avatar === '.' || avatar === '..') {
            throw new Error('人设文件里没有有效的头像文件名，无法合并');
        }
        const image = avatars.get(`${personaFolder(entry)}\0${avatar}`);
        if (!image) throw new Error('缺少人设头像，请连同头像一起下载');
        requireComplete(image, '人设头像');
        data.avatar = path.posix.basename(image.target);
        // 导入副本保留本机默认人设。
        data.isDefault = false;
        return jsonBuffer(data);
    }

    function prepareProfiles(entry, buffer) {
        const data = parseObject(buffer);
        const local = settings();
        const profiles = local.extension_settings?.connectionManager?.profiles || [];
        const stored = readJson(path.join(directories.root, 'secrets.json'));
        const usedIds = new Set(Object.values(stored).filter(Array.isArray).flat().map(item => item?.id));
        const profileIds = new Set(profiles.map(item => item.id));
        const profileNames = new Set(profiles.map(item => item.name));
        const proxyNames = new Set((local.proxies || []).map(item => item.name));
        const secretIds = new Map();
        const proxyNamesBySource = new Map();

        data.secrets = (data.secrets || []).filter(item => {
            if (!item?.key || !item.id) return false;
            const identity = JSON.stringify([item.key, item.id, item.value, item.label]);
            const previous = secretCopies.get(identity);
            if (previous?.entry.complete) {
                secretIds.set(item.id, previous.id);
                return false;
            }
            const sourceId = item.id;
            if (usedIds.has(item.id)) item.id = randomUUID();
            usedIds.add(item.id);
            secretIds.set(sourceId, item.id);
            secretCopies.set(identity, { id: item.id, entry });
            return true;
        });
        data.proxies = (data.proxies || []).filter(proxy => {
            if (!proxy?.name) return false;
            const identity = JSON.stringify(synthetic.stableJson(proxy));
            const previous = proxyCopies.get(identity);
            if (previous?.entry.complete) {
                proxyNamesBySource.set(proxy.name, previous.name);
                return false;
            }
            const sourceName = proxy.name;
            proxy.name = uniqueName(sourceName, name => proxyNames.has(name));
            proxyNames.add(proxy.name);
            proxyNamesBySource.set(sourceName, proxy.name);
            proxyCopies.set(identity, { name: proxy.name, entry });
            return true;
        });
        for (const profile of data.profiles || []) {
            if (!profile?.id) continue;
            if (profileIds.has(profile.id)) profile.id = randomUUID();
            profileIds.add(profile.id);
            profile.name = uniqueName(String(profile.name || profile.id), name => profileNames.has(name));
            profileNames.add(profile.name);
            profile['secret-id'] = secretIds.get(profile['secret-id']) || profile['secret-id'];
            profile.proxy = proxyNamesBySource.get(profile.proxy) || profile.proxy;
        }
        if (data.profiles?.length === 1) {
            entry.target = synthetic.apiLocalPath(paths.safeSegment(data.profiles[0].name));
        }
        return jsonBuffer(data);
    }

    function prepareGroup(entry, buffer) {
        const data = parseObject(buffer);
        data.id = paths.stemOf(path.posix.basename(entry.target));
        const remap = (local, label, stem = false) => {
            const source = byLocal.get(local);
            if (!source) return null;
            requireComplete(source, label);
            const name = path.posix.basename(source.target);
            return stem ? paths.stemOf(name) : name;
        };
        for (const field of ['members', 'disabled_members']) {
            if (Array.isArray(data[field])) data[field] = data[field].map(avatar =>
                remap(`characters/${avatar}`, '角色卡') || avatar);
        }
        if (Array.isArray(data.chats)) data.chats = data.chats.map(id =>
            remap(`group chats/${id}.jsonl`, '群聊记录', true) || id);
        if (data.chat_id) data.chat_id = remap(`group chats/${data.chat_id}.jsonl`, '群聊记录', true) || data.chat_id;
        return jsonBuffer(data);
    }

    return {
        entries: ordered,
        prepare(entry, buffer) {
            requireComplete(entry.parent, '角色卡');
            if (synthetic.isPersonaPath(entry.local)) return preparePersona(entry, buffer);
            if (synthetic.isApiProfilePath(entry.local)) return prepareProfiles(entry, buffer);
            if (entry.local.startsWith('groups/')) return prepareGroup(entry, buffer);
            const root = entry.local.split('/')[0];
            if (entry.target !== entry.local && ['themes', 'QuickReplies', 'worlds'].includes(root)
                && entry.target.toLowerCase().endsWith('.json')) {
                const data = parseObject(buffer);
                // 主题与 QR 按 JSON 内的 name 识别，世界书通常按文件名识别。
                if (root !== 'worlds' || Object.hasOwn(data, 'name')) {
                    data.name = paths.stemOf(path.posix.basename(entry.target));
                }
                return jsonBuffer(data);
            }
            return buffer;
        },
    };
}

module.exports = { createCopyPlan };
