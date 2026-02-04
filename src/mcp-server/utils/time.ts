let lastTimestampMs = 0;

/**
 * Generates a file-safe timestamp string with monotonically increasing values.
 *
 * @param date - The date to format, defaults to current time.
 * @returns A timestamp string in YYYYMMDD-HHMMSS-mmm format.
 */
export function generateFilesafeTimestamp(date: Date = new Date()): string {
  let timestampMs = date.getTime();
  if (timestampMs <= lastTimestampMs) {
    timestampMs = lastTimestampMs + 1;
  }
  lastTimestampMs = timestampMs;

  const normalized = new Date(timestampMs);
  const year = normalized.getFullYear().toString().padStart(4, '0');
  const month = (normalized.getMonth() + 1).toString().padStart(2, '0');
  const day = normalized.getDate().toString().padStart(2, '0');
  const hours = normalized.getHours().toString().padStart(2, '0');
  const minutes = normalized.getMinutes().toString().padStart(2, '0');
  const seconds = normalized.getSeconds().toString().padStart(2, '0');
  const milliseconds = normalized.getMilliseconds().toString().padStart(3, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

/**
 * Generates a unique session identifier.
 *
 * @param prefix - The prefix for the session ID, defaults to 'mm'.
 * @returns A unique session ID string.
 */
export function generateSessionId(prefix = 'mm'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
