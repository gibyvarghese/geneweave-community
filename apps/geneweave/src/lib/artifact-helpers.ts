/**
 * Shared helpers for serializing/deserializing artifact data to/from SQLite columns.
 */

export function serializeArtifactData(data: unknown): { data_text: string | null; data_blob: Buffer | null } {
  if (Buffer.isBuffer(data)) return { data_text: null, data_blob: data };
  if (data instanceof Uint8Array) return { data_text: null, data_blob: Buffer.from(data) };
  if (data instanceof ArrayBuffer) return { data_text: null, data_blob: Buffer.from(data) };
  if (data === null || data === undefined) return { data_text: null, data_blob: null };
  if (typeof data === 'string') return { data_text: data, data_blob: null };
  return { data_text: JSON.stringify(data), data_blob: null };
}

export function deserializeArtifactData(dataText: string | null, dataBlob: Buffer | null): unknown {
  if (dataBlob !== null) return dataBlob;
  if (dataText === null) return null;
  try { return JSON.parse(dataText); } catch { return dataText; }
}

export function estimateArtifactSize(data: unknown): number {
  if (data === null || data === undefined) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  try { return Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch { return 0; }
}
