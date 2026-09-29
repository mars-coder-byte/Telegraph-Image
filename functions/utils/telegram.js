import { isEmptyBinding } from './http.js';

const MAX_RETRIES = 2;

const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

export function validateTelegramConfig(env) {
  if (isEmptyBinding(env.TG_Bot_Token)) {
    throw new Error('Missing required environment variable: TG_Bot_Token');
  }

  if (isEmptyBinding(env.TG_Chat_ID)) {
    throw new Error('Missing required environment variable: TG_Chat_ID');
  }
}

export function mimeFromName(name) {
  const extension = String(name || '').split('.').pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || '';
}

export function resolveFileType(file) {
  const type = String(file.type || '').toLowerCase();
  // Browsers and EdgeOne often label uploads as octet-stream even for images.
  if (type && type !== 'application/octet-stream') {
    return type;
  }

  return mimeFromName(file.name) || type || 'application/octet-stream';
}

// EdgeOne has no File constructor, and fetch() drops binary parts when the
// body is a FormData. Keep the upload as plain bytes instead.
export async function normalizeUploadFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('No file uploaded');
  }

  const name = safeFilename(file.name);
  const type = resolveFileType(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('Uploaded file is empty');
  }

  return { name, type, bytes };
}

export function getUploadTarget(file) {
  const type = resolveFileType(file);

  if (type.startsWith('image/')) {
    return { endpoint: 'sendPhoto', field: 'photo' };
  }

  if (type.startsWith('audio/')) {
    return { endpoint: 'sendAudio', field: 'audio' };
  }

  if (type.startsWith('video/')) {
    return { endpoint: 'sendVideo', field: 'video' };
  }

  return { endpoint: 'sendDocument', field: 'document' };
}

export function createTelegramUpload(chatId, field, file) {
  return {
    chatId: String(chatId),
    field,
    name: safeFilename(file.name),
    type: file.type || 'application/octet-stream',
    bytes: file.bytes,
  };
}

export function getFileId(response) {
  if (!response.ok || !response.result) return null;

  const result = response.result;
  if (result.photo) {
    return result.photo.reduce((prev, current) =>
      (prev.file_size > current.file_size) ? prev : current
    ).file_id;
  }
  if (result.document) return result.document.file_id;
  if (result.video) return result.video.file_id;
  if (result.audio) return result.audio.file_id;

  return null;
}

export async function sendToTelegram(upload, apiEndpoint, env, retryCount = 0) {
  const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

  try {
    const payload = encodeUpload(upload);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': payload.contentType },
      body: payload.body,
    });
    const responseData = await parseTelegramResponse(response);

    if (response.ok) {
      return { success: true, data: responseData };
    }

    if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
      console.log('Retrying image as document...');
      return await sendToTelegram({ ...upload, field: 'document' }, 'sendDocument', env, retryCount + 1);
    }

    return {
      success: false,
      error: formatTelegramError(apiEndpoint, response, responseData),
    };
  } catch (error) {
    console.error('Network error:', error);
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return await sendToTelegram(upload, apiEndpoint, env, retryCount + 1);
    }
    return { success: false, error: 'Network error occurred' };
  }
}

async function parseTelegramResponse(response) {
  const contentType = response.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    return await response.json();
  }

  return { description: await response.text() };
}

function encodeUpload(upload) {
  const boundary = `----TelegramForm${randomHex(16)}`;
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n${upload.chatId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${upload.field}"; filename="${upload.name}"\r\n` +
      `Content-Type: ${upload.type}\r\n\r\n`
    ),
    upload.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ];

  return {
    body: concatBytes(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeFilename(name) {
  const cleaned = String(name || 'file').replace(/[\r\n"]/g, '_');
  return cleaned || 'file';
}

function formatTelegramError(apiEndpoint, response, responseData) {
  const details = responseData?.description || responseData?.error_code || 'Upload to Telegram failed';
  return `Telegram ${apiEndpoint} failed: ${response.status} ${details}`;
}

export async function getTelegramFilePath(env, fileId) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${fileId}`;
    const res = await fetch(url, { method: 'GET' });

    if (!res.ok) {
      console.error(`HTTP error! status: ${res.status}`);
      return null;
    }

    const responseData = await res.json();
    const { ok, result } = responseData;

    if (ok && result) {
      return result.file_path;
    }

    console.error('Error in response data:', responseData);
    return null;
  } catch (error) {
    console.error('Error fetching file path:', error.message);
    return null;
  }
}
