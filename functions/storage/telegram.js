import {
    createTelegramUpload,
    getFileId,
    getTelegramFilePath,
    getUploadTarget,
    normalizeUploadFile,
    sendToTelegram,
    validateTelegramConfig,
} from '../utils/telegram.js';

export const telegramProvider = {
    key: 'telegram',

    validateConfig(env) {
        validateTelegramConfig(env);
    },

    async upload(env, file, { fileExtension }) {
        const normalized = await normalizeUploadFile(file);
        const { endpoint, field } = getUploadTarget(normalized);
        const upload = createTelegramUpload(env.TG_Chat_ID, field, normalized);

        const result = await sendToTelegram(upload, endpoint, env);
        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);
        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        return `${fileId}.${fileExtension}`;
    },

    async fetchFile(env, request, url, fileId) {
        const fileUrl = await resolveFileUrl(env, url, fileId);
        return fetch(fileUrl, {
            method: request.method,
            headers: request.headers,
            body: request.body,
        });
    },
};

async function resolveFileUrl(env, url, fileId) {
    // Same threshold as the old `url.pathname.length > 39` check ('/file/' + id):
    // ids longer than 33 characters were uploaded via the Telegram Bot API.
    if (fileId.length > 33) {
        const filePath = await getTelegramFilePath(env, fileId.split('.')[0]);
        return `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    return 'https://telegra.ph//file/' + fileId + url.search;
}
