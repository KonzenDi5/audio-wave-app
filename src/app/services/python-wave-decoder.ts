import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

interface PythonWaveDecoderResult {
  confidence: number;
  preview: number[];
}

interface PyodideWindow extends Window {
  loadPyodide?: (options: { indexURL: string }) => Promise<PyodideInstance>;
}

interface PyodideGlobals {
  set(name: string, value: unknown): void;
}

interface PyodideInstance {
  globals: PyodideGlobals;
  runPythonAsync<T>(code: string): Promise<T>;
}

@Injectable({
  providedIn: 'root',
})
export class PythonWaveDecoderService {
  private readonly document = inject(DOCUMENT);
  private pyodidePromise: Promise<PyodideInstance | null> | null = null;

  async decodeFrame(
    pixels: Uint8ClampedArray,
    width: number,
    height: number
  ): Promise<Float32Array | null> {
    const pyodide = await this.getPyodide();
    if (!pyodide) {
      return null;
    }

    try {
      pyodide.globals.set('frame_pixels', pixels);
      pyodide.globals.set('frame_width', width);
      pyodide.globals.set('frame_height', height);

      const payload = await pyodide.runPythonAsync<string>(`
import json
json.dumps(decode_wave_frame(frame_pixels, frame_width, frame_height))
      `);

      const result = JSON.parse(payload) as PythonWaveDecoderResult;
      if (!result.preview.length || result.confidence < 0.72) {
        return null;
      }

      return Float32Array.from(result.preview);
    } catch {
      return null;
    }
  }

  private async getPyodide(): Promise<PyodideInstance | null> {
    if (!this.pyodidePromise) {
      this.pyodidePromise = this.loadPyodideRuntime();
    }

    return this.pyodidePromise;
  }

  private async loadPyodideRuntime(): Promise<PyodideInstance | null> {
    const windowRef = this.document.defaultView as PyodideWindow | null;
    if (!windowRef) {
      return null;
    }

    if (!windowRef.loadPyodide) {
      await this.injectScript(
        'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js'
      );
    }

    if (!windowRef.loadPyodide) {
      return null;
    }

    const pyodide = await windowRef.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/',
    });

    await pyodide.runPythonAsync(`
import math

PREVIEW_SAMPLE_COUNT = 384

def _is_wave_pixel(r, g, b):
    return g > 72 and g > r * 1.18 and g > b * 1.08

def _gaussian_smooth(data, radius):
    sigma = radius / 2
    weights = []
    weight_sum = 0.0
    for offset in range(-radius, radius + 1):
        weight = math.exp(-(offset * offset) / (2 * sigma * sigma))
        weights.append(weight)
        weight_sum += weight

    result = []
    length = len(data)
    for index in range(length):
        total = 0.0
        for offset in range(-radius, radius + 1):
            sample_index = (index + offset + length) % length
            total += data[sample_index] * weights[offset + radius]
        result.append(total / weight_sum)
    return result

def decode_wave_frame(frame_pixels, frame_width, frame_height):
    total_x = 0.0
    total_y = 0.0
    pixel_count = 0

    for y in range(frame_height):
        row_offset = y * frame_width * 4
        for x in range(frame_width):
            pixel_offset = row_offset + x * 4
            r = frame_pixels[pixel_offset]
            g = frame_pixels[pixel_offset + 1]
            b = frame_pixels[pixel_offset + 2]
            if not _is_wave_pixel(r, g, b):
                continue
            total_x += x
            total_y += y
            pixel_count += 1

    if pixel_count < 120:
        return {'confidence': 0.0, 'preview': []}

    center_x = total_x / pixel_count
    center_y = total_y / pixel_count
    max_radius = min(frame_width, frame_height) * 0.48
    distances = []

    for index in range(PREVIEW_SAMPLE_COUNT):
        angle = (index / PREVIEW_SAMPLE_COUNT) * math.pi * 2 - math.pi / 2
        farthest_distance = 0.0
        radius = 10.0

        while radius < max_radius:
            sample_x = round(center_x + math.cos(angle) * radius)
            sample_y = round(center_y + math.sin(angle) * radius)

            if sample_x < 0 or sample_x >= frame_width or sample_y < 0 or sample_y >= frame_height:
                break

            pixel_offset = (sample_y * frame_width + sample_x) * 4
            if _is_wave_pixel(
                frame_pixels[pixel_offset],
                frame_pixels[pixel_offset + 1],
                frame_pixels[pixel_offset + 2],
            ):
                farthest_distance = radius

            radius += 1.0

        distances.append(farthest_distance)

    valid_count = len([distance for distance in distances if distance > 0])
    if valid_count < PREVIEW_SAMPLE_COUNT * 0.72:
        return {'confidence': 0.0, 'preview': []}

    smoothed = _gaussian_smooth(distances, 4)
    mean_radius = sum(smoothed) / len(smoothed)
    peak_delta = max(abs(distance - mean_radius) for distance in smoothed)
    if peak_delta < 3:
        return {'confidence': 0.0, 'preview': []}

    preview = []
    for distance in smoothed:
        preview.append(max(-1.0, min(1.0, (distance - mean_radius) / peak_delta)))

    coverage = valid_count / PREVIEW_SAMPLE_COUNT
    confidence = min(1.0, max(0.0, coverage * 0.7 + min(peak_delta / 12.0, 1.0) * 0.3))
    return {'confidence': confidence, 'preview': preview}
    `);

    return pyodide;
  }

  private injectScript(source: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = source;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Falha ao carregar runtime Python'));
      this.document.head.appendChild(script);
    });
  }
}