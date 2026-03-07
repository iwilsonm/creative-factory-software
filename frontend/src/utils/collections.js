export function ensureArray(value, context = 'array') {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  console.warn(`[collections] Expected array for ${context}, received`, value);
  return [];
}

export function normalizeArrayResponse(data, key, context = key) {
  const fromObject = data && typeof data === 'object' && !Array.isArray(data) ? data[key] : undefined;
  const items = ensureArray(Array.isArray(fromObject) ? fromObject : Array.isArray(data) ? data : fromObject, context);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...data, [key]: items };
  }
  return { [key]: items };
}

export function normalizeArrayFields(data, fields) {
  const base = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  for (const [key, context] of Object.entries(fields)) {
    base[key] = ensureArray(base[key], context || key);
  }
  return base;
}
