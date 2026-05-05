const GATEWAY_REQUEST_ID_RE = /\b[a-z]{2,}\d?::[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*\b/i;

function stripHtml(raw = '') {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function parseResponseBody(res) {
  const rawText = await res.text();
  if (!rawText) return { parsed: {}, rawText: '' };
  try {
    return { parsed: JSON.parse(rawText), rawText };
  } catch {
    const isHtml = /<\/?[a-z][\s\S]*>/i.test(rawText);
    return {
      parsed: {
        error: isHtml ? stripHtml(rawText) : rawText.trim(),
        raw_body: rawText,
      },
      rawText,
    };
  }
}

export function getGatewayRequestId(rawText = '') {
  return String(rawText).match(GATEWAY_REQUEST_ID_RE)?.[0] || null;
}

function hasGatewayForbiddenShape(status, message = '', rawText = '') {
  const combined = `${message}\n${rawText}`.trim();
  if (status !== 403) return false;
  return /^Forbidden\b/i.test(combined) || Boolean(getGatewayRequestId(combined));
}

function hasHtmlErrorShape(rawText = '') {
  return /<!doctype html|<html|<\/body>|<\/title>/i.test(String(rawText));
}

export function normalizeApiError({ status = 0, data = {}, rawText = '', fallback = 'Request failed' } = {}) {
  const serverMessage = data?.error || data?.message || '';
  const rawMessage = String(serverMessage || rawText || '').trim();
  const requestId = data?.request_id || getGatewayRequestId(rawText || rawMessage);
  const codeFromServer = data?.code || data?.reason_code;
  let code = codeFromServer || 'UNKNOWN_ERROR';
  let message = rawMessage || fallback;

  if (status === 0) {
    code = codeFromServer || 'NETWORK_ERROR';
    message = 'The request could not reach the server. Check your connection, refresh, and try again.';
  } else if (status === 401) {
    code = codeFromServer || 'AUTH_EXPIRED';
    message = 'Your session expired. Log in again and retry this action.';
  } else if (hasGatewayForbiddenShape(status, rawMessage, rawText)) {
    code = codeFromServer || 'GATEWAY_FORBIDDEN';
    message = 'This request was blocked before it reached the app. Refresh, log in again, and retry. If this was a PDF upload, use a smaller PDF or paste the text manually.';
  } else if (status === 403) {
    code = codeFromServer || 'FORBIDDEN';
    message = rawMessage || 'You are logged in, but this account does not have access to perform that action.';
  } else if (status === 413 || /request entity too large|payload too large|body exceeded|too large/i.test(rawMessage)) {
    code = codeFromServer || 'FILE_TOO_LARGE';
    message = 'That file or request is too large. Use a smaller PDF, split or compress the file, or paste the text manually.';
  } else if (status === 415) {
    code = codeFromServer || 'UNSUPPORTED_FILE_TYPE';
    message = rawMessage || 'That file type is not supported. Upload a PDF, TXT, HTML, DOCX, CSV, JSON, XML, RTF, or spreadsheet file.';
  } else if (status === 429) {
    code = codeFromServer || 'RATE_LIMITED';
    message = 'Too many requests were sent at once. Wait a moment, then try again.';
  } else if (status >= 500) {
    code = codeFromServer || 'SERVER_ERROR';
    message = rawMessage || 'The server hit an unexpected error. Retry once; if it keeps happening, send the technical details to support.';
  } else if (hasHtmlErrorShape(rawText) && !codeFromServer) {
    code = 'INVALID_RESPONSE';
    message = 'The server returned an HTML error page instead of app data. Refresh and try again.';
  } else if (!rawMessage) {
    code = codeFromServer || 'INVALID_RESPONSE';
    message = `${fallback} (${status || 'unknown status'})`;
  }

  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = data?.details;
  error.action = data?.action;
  error.settings_path = data?.settings_path;
  error.settings_subtab = data?.settings_subtab;
  error.stage = data?.stage;
  error.reason_code = data?.reason_code || code;
  error.attempted_methods = data?.attempted_methods;
  error.manual_recovery_steps = data?.manual_recovery_steps;
  error.request_id = requestId;
  error.raw_body = rawText || data?.raw_body;
  error.technical_details = [
    status ? `HTTP ${status}` : null,
    code ? `Code: ${code}` : null,
    requestId ? `Request ID: ${requestId}` : null,
  ].filter(Boolean).join(' · ');

  return error;
}

export async function createApiErrorFromResponse(res, fallback = 'Request failed') {
  const { parsed, rawText } = await parseResponseBody(res);
  return normalizeApiError({ status: res.status, data: parsed, rawText, fallback });
}

export function normalizeFetchException(err, fallback = 'Request failed') {
  if (err?.name === 'AbortError') {
    const abortError = new Error('The request was cancelled before it finished.');
    abortError.code = 'REQUEST_ABORTED';
    return abortError;
  }
  if (err instanceof Error && err.status) return err;
  return normalizeApiError({
    status: 0,
    data: { error: err?.message },
    fallback,
  });
}
