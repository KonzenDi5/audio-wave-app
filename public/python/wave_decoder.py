"""
wave_decoder.py — Python decoder for horizontal waveform strips.

Reads a camera frame, detects the green horizontal waveform strip,
extracts amplitude data from the GREEN CHANNEL INTENSITY of each bar,
computes FFT via numpy, and returns structured data for Web Audio PeriodicWave synthesis.

Encoding: each bar's green channel value encodes the signed amplitude:
    green_value = round((amplitude + 1) * 0.5 * 215 + 40)
    amplitude   = (green_value - 40) / 215 * 2 - 1
Range: green 40 (-1.0) to 255 (+1.0), center at ~147.5 (0.0)
"""

import numpy as np
import json

SAMPLE_COUNT = 384
GREEN_MIN = 40
GREEN_RANGE = 215


def _find_strip_bounds(px, w, h):
    """Find the horizontal strip region using green guide lines."""
    r = px[:, :, 0].astype(np.int16)
    g = px[:, :, 1].astype(np.int16)
    b = px[:, :, 2].astype(np.int16)

    bright_green = (g > 100) & (g > r + 30) & (g > b + 20)
    row_counts = np.sum(bright_green, axis=1)

    threshold = w * 0.25
    guide_rows = np.where(row_counts > threshold)[0]

    if len(guide_rows) < 2:
        return None

    top = int(guide_rows[0])
    bot = int(guide_rows[-1])
    strip_h = bot - top

    if strip_h < h * 0.03 or strip_h > h * 0.6:
        return None

    col_has_green = np.any(bright_green[top:bot + 1, :], axis=0)
    green_cols = np.where(col_has_green)[0]

    if len(green_cols) < w * 0.10:
        return None

    left = int(green_cols[0])
    right = int(green_cols[-1])

    if (right - left) < w * 0.15:
        return None

    ref_top = np.median(px[top, left:right + 1, 1].astype(np.float64))
    ref_bot = np.median(px[bot, left:right + 1, 1].astype(np.float64))
    ref_green = max(float((ref_top + ref_bot) / 2.0), 80.0)

    return top, bot, left, right, ref_green


def _extract_amplitudes(px, top, bot, left, right, ref_green):
    """Extract signed amplitudes from the green channel intensity of each bar column."""
    dw = right - left
    center_y = (top + bot) / 2.0
    half_h = (bot - top) * 0.42
    inner_top = top + 2
    inner_bot = bot - 2

    amplitudes = np.zeros(SAMPLE_COUNT, dtype=np.float64)
    valid_count = 0

    scale = ref_green / 255.0

    for i in range(SAMPLE_COUNT):
        col_x = left + int(round(i / (SAMPLE_COUNT - 1) * dw))
        col_x = min(col_x, px.shape[1] - 1)

        col_slice = px[inner_top:inner_bot, col_x, :]
        r = col_slice[:, 0].astype(np.int16)
        g = col_slice[:, 1].astype(np.int16)
        b = col_slice[:, 2].astype(np.int16)

        green_mask = (g > 35) & (g > r + 10) & (g > b + 5)
        green_positions = np.where(green_mask)[0]

        if len(green_positions) == 0:
            continue

        green_values = g[green_positions].astype(np.float64)

        if scale > 0.01:
            green_values = green_values / scale

        best_idx = np.argmax(green_values)
        intensity = float(green_values[best_idx])

        decoded = (intensity - GREEN_MIN) / GREEN_RANGE * 2.0 - 1.0
        decoded = max(-1.0, min(1.0, decoded))

        median_y = float(np.median(green_positions)) + inner_top
        y_amplitude = (center_y - median_y) / half_h
        y_amplitude = max(-1.0, min(1.0, y_amplitude))

        if abs(decoded) > 0.02:
            amp = decoded * 0.7 + y_amplitude * 0.3
        else:
            amp = y_amplitude

        amplitudes[i] = max(-1.0, min(1.0, amp))
        valid_count += 1

    return amplitudes, valid_count


def decode_wave_frame(pixels_js, w, h):
    """Main entry: decode a camera frame into waveform + FFT data."""
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

    top, bot, left, right, ref_green = bounds

    amplitudes, valid_count = _extract_amplitudes(px, top, bot, left, right, ref_green)

    if valid_count < SAMPLE_COUNT * 0.25:
        return empty

    kernel = np.array([0.05, 0.15, 0.25, 0.30, 0.25, 0.15, 0.05])
    kernel = kernel / kernel.sum()
    smoothed = np.convolve(amplitudes, kernel, mode='same')

    smoothed -= np.mean(smoothed)
    peak = np.max(np.abs(smoothed))
    if peak > 0.005:
        smoothed = smoothed / peak
    else:
        return empty

    fft = np.fft.rfft(smoothed)
    fft_real = np.real(fft)
    fft_imag = np.imag(fft)

    crossings = 0
    for i in range(1, len(smoothed)):
        if smoothed[i - 1] * smoothed[i] < 0:
            crossings += 1

    cycles = max(1, crossings / 2)
    base_freq = max(110.0, min(660.0, 55.0 * cycles))

    confidence = min(1.0, valid_count / SAMPLE_COUNT)

    return json.dumps({
        'confidence': round(float(confidence), 4),
        'preview': [round(float(v), 6) for v in smoothed],
        'fft_real': [round(float(v), 6) for v in fft_real],
        'fft_imag': [round(float(v), 6) for v in fft_imag],
        'base_freq': round(float(base_freq), 2)
    })
