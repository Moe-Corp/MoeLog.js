/**
 * 32-bit FNV-1a. Not cryptographic and not trying to be: it groups identical
 * errors so the client can deduplicate and the server can group issues without
 * recomputing anything.
 */
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Fingerprint of an error. Computed from the error type and a normalized
 * message rather than the raw text, so "user 42 not found" and "user 77 not
 * found" land in the same issue.
 */
export function fingerprintError(name: string, msg: string, topFrame?: string): string {
  const normalized = msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '*')   // ids, hashes, uuids
    .replace(/\b\d+\b/g, '*')             // bare numbers
    .replace(/(["'`]).*?\1/g, '$1*$1')    // quoted literals
  return hash(`${name}|${normalized}|${topFrame ?? ''}`)
}
