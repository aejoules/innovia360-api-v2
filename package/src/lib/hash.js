import crypto from 'crypto';

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

export function sha1HexPrefixed(text) {
  return `sha1:${sha1(text)}`;
}

export function sha256HexPrefixed(text) {
  return `sha256:${sha256(text)}`;
}

/**
 * Stable V0 entity hash.
 * Base: lang + permalink + slug + title + excerpt
 */
export function entityContentHash(entity) {
  const base = [
    entity?.lang ?? '',
    entity?.permalink ?? '',
    entity?.slug ?? '',
    entity?.title ?? '',
    entity?.excerpt ?? ''
  ].join('\n');
  return sha1HexPrefixed(base);
}
