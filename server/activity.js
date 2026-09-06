/** 按连接方案保存最近五次自动上传记录。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function connectionKey(config) {
    return crypto.createHash('sha256').update(JSON.stringify([
        config.activeProfileId, config.url, config.username, config.remotePath,
    ])).digest('hex');
}

function historyPath(directories, config) {
    return path.join(directories.root, '.sillytavern-cloud-backup', 'auto-uploads', `${connectionKey(config)}.json`);
}

function readAutoUploads(directories, config) {
    try {
        return JSON.parse(fs.readFileSync(historyPath(directories, config), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { lastRun: null, runs: [] };
        throw error;
    }
}

function recordAutoUpload(directories, config, result) {
    const history = readAutoUploads(directories, config);
    history.lastRun = {
        at: result.lastBackupAt,
        uploaded: result.uploaded,
        skipped: result.skipped,
        failed: result.errors.length,
    };
    if (result.uploaded || result.errors.length) {
        history.runs.unshift({
            ...history.lastRun,
            files: result.uploadedFiles,
            errors: result.errors,
        });
        history.runs = history.runs.slice(0, 5);
    }
    const file = historyPath(directories, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    return history;
}

module.exports = { connectionKey, readAutoUploads, recordAutoUpload };
