/**
 * Shared utilities for services.
 */

function toKebab(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { toKebab };
