export const PREVIEW_SAMPLE_COUNT = 384;
const HASH_SAMPLE_COUNT = 384;

export function createWaveId(data: Float32Array): string {
  const sampled = sampleWaveform(data, HASH_SAMPLE_COUNT);
  let hash = 0x811c9dc5;

  for (let index = 0; index < sampled.length; index++) {
    const quantized = Math.round((clamp(sampled[index], -1, 1) + 1) * 127.5);
    hash ^= quantized;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
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

export function sampleWaveform(data: Float32Array, sampleCount = PREVIEW_SAMPLE_COUNT): Float32Array {
  const result = new Float32Array(sampleCount);
  if (!data.length) {
    return result;
  }

  for (let index = 0; index < sampleCount; index++) {
    const start = Math.floor((index / sampleCount) * data.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / sampleCount) * data.length));

    let peak = 0;
    let peakAbs = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
      const abs = Math.abs(data[sampleIndex]);
      if (abs > peakAbs) {
        peakAbs = abs;
        peak = data[sampleIndex];
      }
    }

    result[index] = peak;
  }

  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}