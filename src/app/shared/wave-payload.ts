export interface WavePayload {
  version: 1;
  waveId: string;
  preview: Float32Array;
}

const PAYLOAD_PREFIX = 'AW1';
const PREVIEW_SAMPLE_COUNT = 384;
const HASH_SAMPLE_COUNT = 256;

export function createWavePayload(data: Float32Array): string {
  const waveId = createWaveId(data);
  const preview = sampleWaveform(data, PREVIEW_SAMPLE_COUNT);
  const bytes = new Uint8Array(preview.length);

  for (let index = 0; index < preview.length; index++) {
    const sample = clamp(preview[index], -1, 1);
    bytes[index] = Math.round((sample + 1) * 127.5);
  }

  return `${PAYLOAD_PREFIX}.${waveId}.${bytesToBase64(bytes)}`;
}

export function decodeWavePayload(text: string): WavePayload | null {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PAYLOAD_PREFIX || !parts[1] || !parts[2]) {
    return null;
  }

  try {
    const bytes = base64ToBytes(parts[2]);
    const preview = new Float32Array(bytes.length);

    for (let index = 0; index < bytes.length; index++) {
      preview[index] = bytes[index] / 127.5 - 1;
    }

    return {
      version: 1,
      waveId: parts[1],
      preview,
    };
  } catch {
    return null;
  }
}

export function createWaveId(data: Float32Array): string {
  const sampled = sampleWaveform(data, HASH_SAMPLE_COUNT);
  let hash = 0x811c9dc5;

  for (let index = 0; index < sampled.length; index++) {
    const quantized = Math.round((clamp(sampled[index], -1, 1) + 1) * 127.5);
    hash ^= quantized;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  hash ^= data.length >>> 0;
  hash = Math.imul(hash, 0x01000193) >>> 0;

  return hash.toString(16).padStart(8, '0');
}

export function createOverlayAmplitudes(preview: Float32Array, pointCount = 180): number[] {
  const result: number[] = [];
  if (!preview.length) {
    return result;
  }

  for (let point = 0; point < pointCount; point++) {
    const start = Math.floor((point / pointCount) * preview.length);
    const end = Math.max(start + 1, Math.floor(((point + 1) / pointCount) * preview.length));

    let sum = 0;
    for (let index = start; index < end; index++) {
      sum += Math.abs(preview[index]);
    }

    result.push(sum / (end - start));
  }

  return result;
}

function sampleWaveform(data: Float32Array, sampleCount: number): Float32Array {
  const result = new Float32Array(sampleCount);
  if (!data.length) {
    return result;
  }

  for (let index = 0; index < sampleCount; index++) {
    const start = Math.floor((index / sampleCount) * data.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / sampleCount) * data.length));

    let sum = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
      sum += data[sampleIndex];
    }

    result[index] = sum / (end - start);
  }

  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}