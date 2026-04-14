import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

export interface WaveDecodeResult {
  confidence: number;
  preview: Float32Array;
  fftReal: Float32Array;
  fftImag: Float32Array;
  baseFreq: number;
}

interface PyodideWindow extends Window {
  loadPyodide?: (options: { indexURL: string }) => Promise<PyodideInstance>;
}

interface PyodideGlobals {
  set(name: string, value: unknown): void;
}

interface PyodideInstance {
  globals: PyodideGlobals;
  loadPackage(pkg: string | string[]): Promise<void>;
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
  ): Promise<WaveDecodeResult | null> {
    const pyodide = await this.getPyodide();
    if (!pyodide) {
      return null;
    }

    try {
      pyodide.globals.set('frame_pixels', pixels);
      pyodide.globals.set('frame_width', width);
      pyodide.globals.set('frame_height', height);

      const payload = await pyodide.runPythonAsync<string>(
        'decode_wave_frame(frame_pixels, frame_width, frame_height)'
      );

      const raw = JSON.parse(payload) as {
        confidence: number;
        preview: number[];
        fft_real: number[];
        fft_imag: number[];
        base_freq: number;
      };

      if (!raw.preview.length || raw.confidence < 0.4) {
        return null;
      }

      return {
        confidence: raw.confidence,
        preview: Float32Array.from(raw.preview),
        fftReal: Float32Array.from(raw.fft_real),
        fftImag: Float32Array.from(raw.fft_imag),
        baseFreq: raw.base_freq,
      };
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

    await pyodide.loadPackage('numpy');

    await pyodide.runPythonAsync(`
import numpy as np
import json

SAMPLE_COUNT = 384

def decode_wave_frame(pixels_js, w, h):
    empty = json.dumps({
        'confidence': 0,
        'preview': [],
        'fft_real': [],
        'fft_imag': [],
        'base_freq': 220
    })

    buf = pixels_js.to_py()
    px = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)

    r = px[:, :, 0].astype(np.int16)
    g = px[:, :, 1].astype(np.int16)
    b = px[:, :, 2].astype(np.int16)

    green = (g > 80) & (g > (r + r // 5)) & (g > (b + b // 10))

    row_counts = np.sum(green, axis=1)
    guide_rows = np.where(row_counts > w * 0.30)[0]

    if len(guide_rows) < 2:
        return empty

    top = int(guide_rows[0])
    bot = int(guide_rows[-1])
    sh = bot - top

    if sh < h * 0.04 or sh > h * 0.55:
        return empty

    cy = (top + bot) / 2.0
    half_h = sh * 0.42

    strip = green[top:bot + 1, :]
    col_any = np.any(strip, axis=0)
    gcols = np.where(col_any)[0]

    if len(gcols) < w * 0.12:
        return empty

    lx = int(gcols[0])
    rx = int(gcols[-1])
    dw = rx - lx

    if dw < w * 0.20:
        return empty

    samples = np.zeros(SAMPLE_COUNT, dtype=np.float64)
    valid = 0

    for i in range(SAMPLE_COUNT):
        cx_i = lx + int(round(i / (SAMPLE_COUNT - 1) * dw))
        cx_i = min(cx_i, w - 1)

        col_g = green[top + 2:bot - 1, cx_i]
        gpos = np.where(col_g)[0]

        if len(gpos) > 0:
            med_y = float(np.median(gpos)) + top + 2
            amp = (cy - med_y) / half_h
            samples[i] = max(-1.0, min(1.0, amp))
            valid += 1

    if valid < SAMPLE_COUNT * 0.30:
        return empty

    kernel = np.array([0.06, 0.24, 0.4, 0.24, 0.06])
    smoothed = np.convolve(samples, kernel, mode='same')

    smoothed -= np.mean(smoothed)
    peak = np.max(np.abs(smoothed))
    if peak > 0.005:
        smoothed = smoothed / peak

    fft = np.fft.rfft(smoothed)
    fft_r = np.real(fft)
    fft_i = np.imag(fft)

    crossings = 0
    for i in range(1, len(smoothed)):
        if smoothed[i - 1] * smoothed[i] < 0:
            crossings += 1

    cycles = max(1, crossings / 2)
    base_freq = max(110.0, min(660.0, 55.0 * cycles))

    conf = min(1.0, valid / SAMPLE_COUNT)

    return json.dumps({
        'confidence': round(float(conf), 4),
        'preview': [round(float(v), 6) for v in smoothed],
        'fft_real': [round(float(v), 6) for v in fft_r],
        'fft_imag': [round(float(v), 6) for v in fft_i],
        'base_freq': round(float(base_freq), 2)
    })
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