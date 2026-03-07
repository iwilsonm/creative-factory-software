export function ensureArray(value, context = 'array') {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  console.warn(`[collections] Expected array for ${context}, received`, value);
  return [];
}
