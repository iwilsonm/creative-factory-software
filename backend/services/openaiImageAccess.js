import OpenAI from 'openai';

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';
export const OPENAI_ORG_VERIFICATION_URL = 'https://help.openai.com/en/articles/10910291-api-organization-verification';
export const OPENAI_ORG_SETTINGS_URL = 'https://platform.openai.com/settings/organization/general';

function getOpenAIStatus(err) {
  return err?.status || err?.statusCode || err?.response?.status || null;
}

function getOpenAICode(err) {
  return (
    err?.code ||
    err?.error?.code ||
    err?.response?.data?.error?.code ||
    null
  );
}

function getOpenAIType(err) {
  return (
    err?.type ||
    err?.error?.type ||
    err?.response?.data?.error?.type ||
    null
  );
}

function getOpenAIMessage(err) {
  return (
    err?.message ||
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    'OpenAI image check failed.'
  );
}

export function classifyOpenAIImageAccessError(err, model = DEFAULT_OPENAI_IMAGE_MODEL) {
  const statusCode = getOpenAIStatus(err);
  const code = getOpenAICode(err);
  const type = getOpenAIType(err);
  const rawMessage = getOpenAIMessage(err);
  const message = String(rawMessage).toLowerCase();

  if (
    statusCode === 401 ||
    code === 'invalid_api_key' ||
    message.includes('incorrect api key')
  ) {
    return {
      success: false,
      model,
      status: 'unauthorized',
      code: code || 'unauthorized',
      message: `OpenAI API key was rejected. Ask the API key owner to confirm the stored key is correct and belongs to the verified organization. Verification guide: ${OPENAI_ORG_VERIFICATION_URL}`,
    };
  }

  if (
    message.includes('organization verification') ||
    message.includes('verify your organization') ||
    message.includes('organization must be verified') ||
    message.includes('must be verified')
  ) {
    return {
      success: false,
      model,
      status: 'org_not_verified',
      code: code || 'organization_not_verified',
      message: `GPT Image 2 still requires API Organization Verification for this key or organization. Ask the API key owner to complete verification here: ${OPENAI_ORG_SETTINGS_URL}. OpenAI guide: ${OPENAI_ORG_VERIFICATION_URL}`,
    };
  }

  if (
    statusCode === 404 ||
    code === 'model_not_found' ||
    (message.includes('model') && (
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('do not have access') ||
      message.includes('don\'t have access')
    ))
  ) {
    return {
      success: false,
      model,
      status: 'model_unavailable',
      code: code || 'model_not_available',
      message: `${model} is not available to this OpenAI API key or project yet. Ask the API key owner to check model access and organization verification: ${OPENAI_ORG_SETTINGS_URL}`,
    };
  }

  if (statusCode === 403) {
    return {
      success: false,
      model,
      status: 'access_denied',
      code: code || 'access_denied',
      message: `OpenAI denied access to ${model}. Ask the API key owner to confirm the key belongs to the verified organization and project: ${OPENAI_ORG_SETTINGS_URL}`,
    };
  }

  if (statusCode === 429) {
    return {
      success: false,
      model,
      status: 'rate_limited',
      code: code || 'rate_limited',
      message: 'OpenAI rate-limited the GPT Image 2 check. Try again later.',
    };
  }

  if (!statusCode || statusCode >= 500) {
    return {
      success: false,
      model,
      status: 'transient_error',
      code: code || type || 'openai_unavailable',
      message: `OpenAI image check failed temporarily: ${rawMessage}`,
    };
  }

  return {
    success: false,
    model,
    status: 'api_error',
    code: code || type || `http_${statusCode}`,
    message: `OpenAI image check failed: ${rawMessage}`,
  };
}

export function toOpenAIImageRuntimeError(err, model = DEFAULT_OPENAI_IMAGE_MODEL) {
  const result = classifyOpenAIImageAccessError(err, model);
  const next = new Error(result.message);
  next.code = result.code;
  next.status = getOpenAIStatus(err);
  next.openAIImageStatus = result.status;
  next.cause = err;
  return next;
}

export async function testOpenAIImageAccess({ apiKey, model = DEFAULT_OPENAI_IMAGE_MODEL }) {
  const activeModel = model || DEFAULT_OPENAI_IMAGE_MODEL;

  if (!apiKey) {
    return {
      success: false,
      model: activeModel,
      status: 'missing_key',
      code: 'missing_openai_api_key',
      message: 'OpenAI API key not configured.',
    };
  }

  const openai = new OpenAI({ apiKey });

  try {
    const response = await openai.images.generate({
      model: activeModel,
      prompt: 'A tiny neutral test image for API access verification.',
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
      n: 1,
    });

    if (!response?.data?.[0]?.b64_json) {
      return {
        success: false,
        model: activeModel,
        status: 'api_error',
        code: 'no_image_data',
        message: 'OpenAI accepted the GPT Image 2 request but returned no image data.',
      };
    }

    return {
      success: true,
      model: activeModel,
      status: 'available',
      code: null,
      message: `${activeModel} is available for this OpenAI API key.`,
    };
  } catch (err) {
    return classifyOpenAIImageAccessError(err, activeModel);
  }
}
