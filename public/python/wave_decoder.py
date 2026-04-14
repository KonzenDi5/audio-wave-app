"""
wave_decoder.py — Python decoder for horizontal waveform strips.

Reads a camera frame, detects the green-bordered horizontal waveform strip,
extracts amplitude from bar height (Y position) + green channel encoding,
computes FFT via numpy, keeps only the first N harmonics for clean synthesis,
and returns structured data for Web Audio PeriodicWave.

Encoding in export:
    green_value = round((amplitude + 1) * 0.5 * 215 + 40)  → [40..255]
    amplitude   = (green_value - 40) / 215 * 2 - 1          → [-1..+1]
"""

import numpy as np
import json

SAMPLE_COUNT = 384
GREEN_MIN = 40
GREEN_RANGE = 215
MAX_HARMONICS = 24


def _find_strip_bounds(px, w, h):
    """Find the horizontal strip via bright green guide lines at top/bottom."""
    r = px[:, :, 0].astype(np.int16)
    g = px[:, :, 1].astype(np.int16)
    b = px[:, :, 2].astype(np.int16)

    bright_green = (g > 90) & (g > r + 20) & (g > b + 15)
    row_counts = np.sum(bright_green, axis=1)

    threshold = w * 0.20
    guide_rows = np.where(row_counts > threshold)[0]

    if len(guide_rows) < 4:
        return None

    top = int(guide_rows[0])
    bot = int(guide_rows[-1])
    strip_h = bot - top

    if strip_h < h * 0.05 or strip_h > h * 0.70:
        return None

    col_any = np.any(bright_green[top:bot + 1, :], axis=0)
    gcols = np.where(col_any)[0]

    if len(gcols) < w * 0.10:
        return None

    left = int(gcols[0])
    right = int(gcols[-1])

    if (right - left) < w * 0.15:
        return None

    return top, bot, left, right


def _extract_amplitudes(px, top, bot, left, right):
    """Extract amplitude per bar using BOTH green-intensity decoding and Y position."""
    dw = right - left
    center_y = (top + bot) / 2.0
    half_h = (bot - top) * 0.45
    inner_top = top + 3
    inner_bot = bot - 3

    amplitudes = np.zeros(SAMPLE_COUNT, dtype=np.float64)
    valid_count = 0

    for i in range(SAMPLE_COUNT):
        col_x = left + int(round(i / (SAMPLE_COUNT - 1) * dw))
        col_x = max(0, min(col_x, px.shape[1] - 1))

        col_slice = px[inner_top:inner_bot, col_x, :]
        col_r = col_slice[:, 0].astype(np.float64)
        col_g = col_slice[:, 1].astype(np.float64)
        col_b = col_slice[:, 2].astype(np.float64)

        brightness = col_r + col_g + col_b
        bar_mask = brightness > 60

        positions = np.where(bar_mask)[0]

        if len(positions) < 2:
            continue

        bar_top = float(positions[0])
        bar_bot = float(positions[-1])
        bar_center = (bar_top + bar_bot) / 2.0

        y_amp = (((inner_bot - inner_top) / 2.0) - bar_center) / half_h
        y_amp = max(-1.0, min(1.0, y_amp))

        green_vals = col_g[positions]
        max_green = float(np.max(green_vals))

        if max_green > 35:
            decoded = (max_green - GREEN_MIN) / GREEN_RANGE * 2.0 - 1.0
            decoded = max(-1.0, min(1.0, decoded))
            amp = decoded * 0.6 + y_amp * 0.4
        else:
            amp = y_amp

        amplitudes[i] = max(-1.0, min(1.0, amp))
        valid_count += 1

    return amplitudes, valid_count


def decode_wave_frame(pixels_js, w, h):
    """Main entry: decode camera frame → waveform + FFT (limited harmonics)."""
    empty = json.dumps({
        'confidence': 0,
        'preview': [],
        'fft_real': [],
        'fft_imag': [],
        'base_freq': 220
    })

    try:
        buf = pixels_js.to_py()
    except Exception:
        buf = bytes(pixels_js)

    px = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)

    bounds = _find_strip_bounds(px, w, h)
    if bounds is None:
        return empty

    top, bot, left, right = bounds

    amplitudes, valid_count = _extract_amplitudes(px, top, bot, left, right)

    if valid_count < SAMPLE_COUNT * 0.20:
        return empty

    # Suavização
    kernel = np.array([0.04, 0.12, 0.20, 0.28, 0.20, 0.12, 0.04])
    kernel = kernel / kernel.sum()
    smoothed = np.convolve(amplitudes, kernel, mode='same')

    # Normalização
    smoothed -= np.mean(smoothed)
    peak = np.max(np.abs(smoothed))
    if peak < 0.01:
        return empty
    smoothed = smoothed / peak

    # FFT completa
    full_fft = np.fft.rfft(smoothed)

    # LIMITAÇÃO DE HARMÔNICOS: manter apenas os primeiros N para som limpo
    clean_fft = np.zeros_like(full_fft)
    n = min(MAX_HARMONICS, len(full_fft))
    clean_fft[:n] = full_fft[:n]

    fft_real = np.real(clean_fft)
    fft_imag = np.imag(clean_fft)

    # Frequência base via autocorrelação
    autocorr = np.correlate(smoothed, smoothed, mode='full')
    autocorr = autocorr[len(smoothed):]
    min_lag = max(2, len(smoothed) // 40)
    max_lag = len(smoothed) // 2

    if max_lag > min_lag:
        search = autocorr[min_lag:max_lag]
        best_lag = int(np.argmax(search)) + min_lag
        cycles = len(smoothed) / best_lag
        base_freq = max(110.0, min(440.0, 55.0 * cycles))
    else:
        base_freq = 220.0

    confidence = min(1.0, valid_count / SAMPLE_COUNT)

    return json.dumps({
        'confidence': round(float(confidence), 4),
        'preview': [round(float(v), 5) for v in smoothed],
        'fft_real': [round(float(v), 5) for v in fft_real],
        'fft_imag': [round(float(v), 5) for v in fft_imag],
        'base_freq': round(float(base_freq), 1)
    })
