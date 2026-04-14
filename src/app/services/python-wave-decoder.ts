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

    // Carrega o decoder Python real do arquivo .py
    const response = await fetch('/python/wave_decoder.py');
    const pythonCode = await response.text();
    await pyodide.runPythonAsync<void>(pythonCode);

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