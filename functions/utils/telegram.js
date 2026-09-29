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

// EdgeOne's request.formData() File often has an empty MIME type, and its
// fetch() drops binary parts when the body is a FormData. Copy the bytes into
// a fresh File so later reads stay valid and the type can be inferred.
export async function normalizeUploadFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('No file uploaded');
  }

  const name = safeFilename(file.name);
  const type = resolveFileType(file);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error('Uploaded file is empty');
  }

  return new File([bytes], name, { type });
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

export function createTelegramFormData(chatId, field, file) {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append(field, file, safeFilename(file.name));
  return formData;
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

export async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
  const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

  try {
    const payload = await encodeFormData(formData);
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
      const newFormData = new FormData();
      newFormData.append('chat_id', formData.get('chat_id'));
      newFormData.append('document', formData.get('photo'));
      return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
    }

    return {
      success: false,
      error: formatTelegramError(apiEndpoint, response, responseData),
    };
  } catch (error) {
    console.error('Network error:', error);
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
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

async function encodeFormData(formData) {
  const boundary = `----TelegramForm${crypto.randomUUID().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const chunks = [];

  for (const [name, value] of formData.entries()) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));

    if (typeof value === 'string') {
      chunks.push(encoder.encode(
        `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
      continue;
    }

    const filename = safeFilename(value.name);
    const type = value.type || 'application/octet-stream';
    chunks.push(encoder.encode(
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`
    ));
    chunks.push(new Uint8Array(await value.arrayBuffer()));
    chunks.push(encoder.encode('\r\n'));
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));

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
