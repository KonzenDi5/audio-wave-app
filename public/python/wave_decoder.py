"""
wave_decoder.py — Python decoder for horizontal waveform strips.

Reads a camera frame, detects the green-bordered horizontal waveform strip,
extracts amplitude per bar via multi-column averaging, then generates a clean
PCM audio buffer via wavetable synthesis with numpy.

Pipeline:
  1. Detect green guide lines → find strip bounds
  2. Extract amplitude per bar (average ±3 pixel columns for noise reduction)
  3. Double-pass smoothing → normalize
  4. Resample to one waveform period at 220 Hz
  5. Low-pass via FFT (keep 12 harmonics) for clean tone
  6. Tile exact number of periods → perfectly seamless loop
  7. Return as base64-encoded int16 PCM at 22050 Hz
"""

import numpy as np
import json
import base64

SAMPLE_COUNT = 384
GREEN_MIN = 40
GREEN_RANGE = 215
OUTPUT_RATE = 22050
BASE_FREQUENCY = 220.0
MAX_HARMONICS = 12
COL_AVG_RADIUS = 3


def _find_strip_bounds(px, w, h):
    """Find the horizontal strip via bright green guide lines at top/bottom."""
    g = px[:, :, 1].astype(np.int16)
    r = px[:, :, 0].astype(np.int16)
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
    """Extract amplitude per bar using multi-column averaging + Y position."""
    dw = right - left
    half_strip = (bot - top) / 2.0
    inner_top = top + 3
    inner_bot = bot - 3
    strip_center_local = (inner_bot - inner_top) / 2.0

    amplitudes = np.zeros(SAMPLE_COUNT, dtype=np.float64)
    valid_count = 0

    for i in range(SAMPLE_COUNT):
        col_x = left + int(round(i / (SAMPLE_COUNT - 1) * dw))

        # Average ±COL_AVG_RADIUS adjacent columns to reduce camera noise
        x_lo = max(0, col_x - COL_AVG_RADIUS)
        x_hi = min(px.shape[1], col_x + COL_AVG_RADIUS + 1)
        region = px[inner_top:inner_bot, x_lo:x_hi, :].astype(np.float64)
        col_avg = np.mean(region, axis=1)  # shape: (strip_height, 4)

        brightness = col_avg[:, 0] + col_avg[:, 1] + col_avg[:, 2]
        bar_mask = brightness > 60
        positions = np.where(bar_mask)[0]

        if len(positions) < 2:
            continue

        bar_top_pos = float(positions[0])
        bar_bot_pos = float(positions[-1])
        bar_center = (bar_top_pos + bar_bot_pos) / 2.0

        # Y-position amplitude (geometric — survives camera well)
        y_amp = (strip_center_local - bar_center) / (half_strip * 0.45)
        y_amp = max(-1.0, min(1.0, y_amp))

        # Green channel decoding (color-based — less reliable through camera)
        col_green = col_avg[positions, 1]
        max_green = float(np.max(col_green))

        if max_green > 35:
            decoded = (max_green - GREEN_MIN) / GREEN_RANGE * 2.0 - 1.0
            decoded = max(-1.0, min(1.0, decoded))
            # Favor Y-position (70%) over green (30%) for camera robustness
            amp = decoded * 0.3 + y_amp * 0.7
        else:
            amp = y_amp

        amplitudes[i] = max(-1.0, min(1.0, amp))
        valid_count += 1

    return amplitudes, valid_count


def _generate_audio_buffer(amplitudes):
    """
    Wavetable synthesis: clean periodic audio from extracted amplitudes.

    1. Resample 384 amplitudes to one exact period at BASE_FREQUENCY
    2. Low-pass filter via FFT (keep MAX_HARMONICS harmonics)
    3. Tile exact number of periods → perfectly seamless loop
    4. No crossfade needed — period boundaries align perfectly
    """
    # One period length in samples
    period_len = int(round(OUTPUT_RATE / BASE_FREQUENCY))

    # Resample 384 → period_len via linear interpolation
    x_orig = np.linspace(0, 1, len(amplitudes), endpoint=False)
    x_new = np.linspace(0, 1, period_len, endpoint=False)
    one_period = np.interp(x_new, x_orig, amplitudes)

    # Low-pass: keep only first MAX_HARMONICS harmonics via FFT
    fft = np.fft.rfft(one_period)
    n_keep = min(MAX_HARMONICS + 1, len(fft))  # +1 because bin 0 is DC
    fft[n_keep:] = 0
    fft[0] = 0  # remove DC offset
    one_period = np.fft.irfft(fft, n=period_len)

    # Exact number of full periods to fill ~1 second
    n_periods = max(1, int(round(OUTPUT_RATE / period_len)))
    n_out = n_periods * period_len

    # Tile
    audio = np.tile(one_period, n_periods)

    # Normalize
    peak = np.max(np.abs(audio))
    if peak < 0.001:
        t = np.arange(n_out, dtype=np.float64) / OUTPUT_RATE
        audio = 0.7 * np.sin(2.0 * np.pi * BASE_FREQUENCY * t)
    else:
        audio = audio / peak * 0.8

    # Convert to int16
    pcm = (audio * 32767).astype(np.int16)
    return base64.b64encode(pcm.tobytes()).decode('ascii')


def decode_wave_frame(pixels_js, w, h):
    """Main entry point: decode camera frame → preview + PCM audio buffer."""
    empty = json.dumps({
        'confidence': 0,
        'preview': [],
        'pcm_b64': '',
        'sample_rate': OUTPUT_RATE
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

    # Heavy smoothing: apply kernel twice to suppress camera noise
    kernel = np.array([0.06, 0.1, 0.15, 0.19, 0.15, 0.1, 0.06])
    kernel = kernel / kernel.sum()
    smoothed = np.convolve(amplitudes, kernel, mode='same')
    smoothed = np.convolve(smoothed, kernel, mode='same')  # second pass

    # Remove DC and normalize
    smoothed -= np.mean(smoothed)
    peak = np.max(np.abs(smoothed))
    if peak < 0.01:
        return empty
    smoothed = smoothed / peak

    # Generate audio buffer via wavetable synthesis
    pcm_b64 = _generate_audio_buffer(smoothed)

    confidence = min(1.0, valid_count / SAMPLE_COUNT)

    return json.dumps({
        'confidence': round(float(confidence), 4),
        'preview': [round(float(v), 4) for v in smoothed],
        'pcm_b64': pcm_b64,
        'sample_rate': OUTPUT_RATE
    })
