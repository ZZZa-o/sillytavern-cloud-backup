import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

export const EXT_ID = 'webdav-chat-backup';
export const SECRET_KEY = 'webdav_chat_backup_password';

export const DEFAULT_SETTINGS = {
    url: '',
    username: '',
    remotePath: 'SillyTavern-WebDAV-Backup',
    includeChats: true,
    includeGroupChats: true,
    includeCharacters: true,
    includeWorlds: true,
    includeSettings: true,
    retention: 10,
    autoEnabled: false,
    autoIntervalHours: 6,
    autoOnChatEvents: true,
    autoMode: 'sync',
    deviceName: '',
    syncDirection: 'two-way',
    passwordSaved: false,
    lastBackupAt: '',
    lastBackupFile: '',
    lastSyncAt: '',
    lastStatus: '',
};

function copyDefaults() {
    return typeof structuredClone === 'function'
        ? structuredClone(DEFAULT_SETTINGS)
        : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = copyDefaults();
    }
    const settings = extension_settings[EXT_ID];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined || settings[key] === null) {
            settings[key] = value;
        }
    }
    return settings;
}

export function saveSettings() {
    saveSettingsDebounced();
}

const val = id => $(`#${id}`).val()?.toString() ?? '';
const trimmed = id => val(id).trim();
const checked = id => $(`#${id}`).prop('checked');

/** 把面板上的当前输入写回设置。不负责重启定时器，避免与 auto 模块相互依赖。 */
export function readFormIntoSettings() {
    const s = getSettings();
    s.url = trimmed('wdcb-url');
    s.username = trimmed('wdcb-username');
    s.remotePath = trimmed('wdcb-remote-path');
    s.includeChats = checked('wdcb-include-chats');
    s.includeGroupChats = checked('wdcb-include-group-chats');
    s.includeCharacters = checked('wdcb-include-characters');
    s.includeWorlds = checked('wdcb-include-worlds');
    s.includeSettings = checked('wdcb-include-settings');
    s.deviceName = trimmed('wdcb-device-name').slice(0, 40);
    s.syncDirection = val('wdcb-sync-direction') || 'two-way';
    s.autoEnabled = checked('wdcb-auto-enabled');
    s.autoOnChatEvents = checked('wdcb-auto-events');
    s.autoMode = val('wdcb-auto-mode') || 'sync';
    s.autoIntervalHours = Math.max(0.25, Number(val('wdcb-auto-hours')) || DEFAULT_SETTINGS.autoIntervalHours);
    s.retention = Math.max(1, Math.floor(Number(val('wdcb-retention')) || DEFAULT_SETTINGS.retention));
    saveSettings();
    return s;
}

/** 后端 resolveConfig 期望的形状。 */
export function getPayloadSettings() {
    const s = getSettings();
    return {
        url: s.url,
        username: s.username,
        remotePath: s.remotePath,
        include: {
            chats: !!s.includeChats,
            groupChats: !!s.includeGroupChats,
            characters: !!s.includeCharacters,
            worlds: !!s.includeWorlds,
            settings: !!s.includeSettings,
        },
        direction: s.syncDirection || 'two-way',
        deviceName: s.deviceName || '',
        retention: Math.max(1, Math.floor(Number(s.retention) || DEFAULT_SETTINGS.retention)),
    };
}
