"""
wave_decoder.py — Python decoder for horizontal waveform strips.

Reads a camera frame, detects the green-bordered horizontal waveform strip,
extracts amplitude per bar, then generates a REAL audio PCM buffer via
additive synthesis with numpy.

The PCM buffer is returned as base64-encoded int16 audio at 22050 Hz (1 second).
This is played directly as an AudioBuffer in the browser — no oscillator needed.
"""

import numpy as np
import json
import base64

SAMPLE_COUNT = 384
GREEN_MIN = 40
GREEN_RANGE = 215
OUTPUT_RATE = 22050
OUTPUT_DURATION = 1.0
MAX_HARMONICS = 16
BASE_FREQUENCY = 220.0


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
    """Extract amplitude per bar using bar height position + green intensity."""
    dw = right - left
    half_strip = (bot - top) / 2.0
    center_row = (top + bot) / 2.0
    inner_top = top + 3
    inner_bot = bot - 3

    amplitudes = np.zeros(SAMPLE_COUNT, dtype=np.float64)
    valid_count = 0

    for i in range(SAMPLE_COUNT):
        col_x = left + int(round(i / (SAMPLE_COUNT - 1) * dw))
        col_x = max(0, min(col_x, px.shape[1] - 1))

        col_slice = px[inner_top:inner_bot, col_x, :]
        brightness = (
            col_slice[:, 0].astype(np.float64) +
            col_slice[:, 1].astype(np.float64) +
            col_slice[:, 2].astype(np.float64)
        )
        bar_mask = brightness > 60
        positions = np.where(bar_mask)[0]

        if len(positions) < 2:
            continue

        bar_top_pos = float(positions[0])
        bar_bot_pos = float(positions[-1])
        bar_center = (bar_top_pos + bar_bot_pos) / 2.0

        strip_center_local = (inner_bot - inner_top) / 2.0
        y_amp = (strip_center_local - bar_center) / (half_strip * 0.45)
        y_amp = max(-1.0, min(1.0, y_amp))

        col_green = col_slice[positions, 1].astype(np.float64)
        max_green = float(np.max(col_green))

        if max_green > 35:
            decoded = (max_green - GREEN_MIN) / GREEN_RANGE * 2.0 - 1.0
            decoded = max(-1.0, min(1.0, decoded))
            amp = decoded * 0.6 + y_amp * 0.4
        else:
            amp = y_amp

        amplitudes[i] = max(-1.0, min(1.0, amp))
        valid_count += 1

    return amplitudes, valid_count


def _generate_audio_buffer(amplitudes):
    """
    Generate clean audio PCM from the 384 amplitude values.

    Strategy: treat the 384 samples as one waveform period, decompose
    into harmonics via FFT, keep only the first 16, and synthesize
    1 second of audio via additive synthesis at exact integer-ratio
    frequencies. This produces a clean, musical tone.
    """
    n_out = int(OUTPUT_RATE * OUTPUT_DURATION)

    # FFT decomposition of the 384-sample waveform
    fft = np.fft.rfft(amplitudes)

    # Time array for output
    t = np.arange(n_out, dtype=np.float64) / OUTPUT_RATE

    # Additive synthesis: sum harmonics with correct amplitudes and phases
    audio = np.zeros(n_out, dtype=np.float64)
    n_harmonics = min(MAX_HARMONICS, len(fft) - 1)

    for k in range(1, n_harmonics + 1):
        mag = np.abs(fft[k])
        phase = np.angle(fft[k])
        freq = BASE_FREQUENCY * k
        if freq > OUTPUT_RATE / 2:
            break
        audio += mag * np.cos(2.0 * np.pi * freq * t + phase)

    # Normalize
    peak = np.max(np.abs(audio))
    if peak < 0.001:
        # Fallback: generate a simple sine if waveform had no content
        audio = 0.7 * np.sin(2.0 * np.pi * BASE_FREQUENCY * t)
    else:
        audio = audio / peak * 0.85

    # Smooth loop: crossfade first/last 500 samples
    fade_len = min(500, n_out // 4)
    fade = np.linspace(0, 1, fade_len)
    audio[:fade_len] *= fade
    audio[-fade_len:] *= fade[::-1]

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

    # Smooth extracted amplitudes
    kernel = np.array([0.04, 0.12, 0.20, 0.28, 0.20, 0.12, 0.04])
    kernel = kernel / kernel.sum()
    smoothed = np.convolve(amplitudes, kernel, mode='same')

    # Remove DC and normalize
    smoothed -= np.mean(smoothed)
    peak = np.max(np.abs(smoothed))
    if peak < 0.01:
        return empty
    smoothed = smoothed / peak

    # Generate audio buffer
    pcm_b64 = _generate_audio_buffer(smoothed)

    confidence = min(1.0, valid_count / SAMPLE_COUNT)

    return json.dumps({
        'confidence': round(float(confidence), 4),
        'preview': [round(float(v), 4) for v in smoothed],
        'pcm_b64': pcm_b64,
        'sample_rate': OUTPUT_RATE
    })
