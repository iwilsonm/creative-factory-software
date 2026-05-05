import { createApiErrorFromResponse, normalizeFetchException } from './apiErrors';

export async function fetchBlobOrThrow(url, fallback = 'Download failed') {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw normalizeFetchException(err, fallback);
  }

  if (!response.ok) {
    throw await createApiErrorFromResponse(response, fallback);
  }

  return response.blob();
}
