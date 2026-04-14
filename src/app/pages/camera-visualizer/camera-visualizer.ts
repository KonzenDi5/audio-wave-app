import {
  Component,
  ElementRef,
  ViewChild,
  OnDestroy,
  signal,
  inject,
  NgZone,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { AudioService } from '../../services/audio';
import {
  PythonWaveDecoderService,
  WaveDecodeResult,
} from '../../services/python-wave-decoder';
import { createOverlayAmplitudes } from '../../shared/wave-payload';

@Component({
  selector: 'app-camera-visualizer',
  imports: [RouterLink],
  templateUrl: './camera-visualizer.html',
  styleUrl: './camera-visualizer.scss',
})
export class CameraVisualizerPage implements OnDestroy {
  @ViewChild('videoElement', { static: true }) videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlayCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private readonly ngZone = inject(NgZone);
  private readonly audioService = inject(AudioService);
  private readonly pythonWaveDecoder = inject(PythonWaveDecoderService);
  private mediaStream: MediaStream | null = null;
  private animationId = 0;
  private scanCanvas: HTMLCanvasElement | null = null;
  private scanCtx: CanvasRenderingContext2D | null = null;
  private usingSessionAudio = false;
  private lastDetectedPreview: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private isDecodingFrame = false;

  private waveAmplitudes: number[] = [];

  // Síntese via AudioBuffer (Python PCM)
  private audioCtx: AudioContext | null = null;
  private bufferSourceNode: AudioBufferSourceNode | null = null;
  private synthGainNode: GainNode | null = null;
  private lastBufferPreview: Float32Array<ArrayBufferLike> = new Float32Array(0);

  readonly isActive = signal(false);
  readonly isDetected = signal(false);
  readonly isPlayingAudio = signal(false);
  readonly isMuted = signal(false);
  readonly hasError = signal('');
  readonly facingMode = signal<'environment' | 'user'>('environment');
  readonly playbackMode = signal<'none' | 'session' | 'preview'>('none');

  async startCamera(): Promise<void> {
    this.hasError.set('');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: this.facingMode(),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      const video = this.videoRef.nativeElement;
      video.srcObject = this.mediaStream;

      await new Promise<void>((resolve) => {
        const aoIniciar = () => {
          video.removeEventListener('playing', aoIniciar);
          resolve();
        };

        video.addEventListener('playing', aoIniciar);
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch(() => {});
        }

        setTimeout(() => resolve(), 4000);
      });

      this.scanCanvas = document.createElement('canvas');
      this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true })!;
      await this.initAudio();

      this.isActive.set(true);
      this.ngZone.runOutsideAngular(() => this.animate());
    } catch (err) {
      this.mediaStream?.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;

      const detalhe = err instanceof Error ? err.message : String(err);
      const mensagem =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permissão negada. Habilite a câmera nas configurações.'
          : `Erro ao iniciar câmera: ${detalhe}`;
      this.hasError.set(mensagem);
    }
  }

  stopCamera(): void {
    cancelAnimationFrame(this.animationId);
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.scanCanvas = null;
    this.scanCtx = null;
    this.clearDetection();
    this.destroyAudio();
    this.audioService.setMuted(false);
    this.isMuted.set(false);
    this.isActive.set(false);
  }

  toggleCamera(): void {
    this.facingMode.set(this.facingMode() === 'environment' ? 'user' : 'environment');
    if (this.isActive()) {
      this.stopCamera();
      void this.startCamera();
    }
  }

  toggleMute(): void {
    const nextMuted = !this.isMuted();
    this.isMuted.set(nextMuted);
    if (this.synthGainNode && this.audioCtx) {
      this.synthGainNode.gain.setTargetAtTime(
        nextMuted ? 0 : 0.4,
        this.audioCtx.currentTime,
        0.05
      );
    }
    this.audioService.setMuted(nextMuted);
  }

  async captureSnapshot(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;
    const video = this.videoRef.nativeElement;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = video.videoWidth || 1080;
    exportCanvas.height = video.videoHeight || 1920;
    const ctx = exportCanvas.getContext('2d')!;

    ctx.drawImage(video, 0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      exportCanvas.toBlob(resolve, 'image/png')
    );

    if (!blob) {
      return;
    }

    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      const file = new File([blob], 'wave-scan.png', { type: 'image/png' });
      await navigator.share({ files: [file], title: 'Wave Scan' });
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wave-scan-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }

  private async initAudio(): Promise<void> {
    try {
      const AudioCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioCtor) {
        return;
      }

      this.audioCtx = new AudioCtor();
      await this.audioCtx.resume();

      this.synthGainNode = this.audioCtx.createGain();
      this.synthGainNode.gain.value = 0;
      this.synthGainNode.connect(this.audioCtx.destination);
    } catch (err) {
      console.warn('Não foi possível inicializar áudio:', err);
    }
  }

  private destroyAudio(): void {
    if (this.bufferSourceNode) {
      try { this.bufferSourceNode.stop(); } catch { /* already stopped */ }
      this.bufferSourceNode.disconnect();
      this.bufferSourceNode = null;
    }

    this.synthGainNode?.disconnect();
    this.synthGainNode = null;
    this.lastBufferPreview = new Float32Array(0);

    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  private animate(): void {
    const canvas = this.canvasRef.nativeElement;
    const video = this.videoRef.nativeElement;
    let frameCount = 0;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      if (!this.scanCanvas || !this.scanCtx) {
        return;
      }

      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      if (!videoWidth || !videoHeight) {
        return;
      }

      frameCount += 1;
      if (frameCount % 4 === 0) {
        void this.scanFrame(video, videoWidth, videoHeight);
      }

      const rect = video.getBoundingClientRect();
      if (canvas.width !== rect.width * 2 || canvas.height !== rect.height * 2) {
        canvas.width = rect.width * 2;
        canvas.height = rect.height * 2;
      }

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (this.waveAmplitudes.length > 0) {
        this.drawDetectedWave(ctx, rect.width, rect.height);
      }
    };

    draw();
  }

  private async scanFrame(
    video: HTMLVideoElement,
    videoWidth: number,
    videoHeight: number
  ): Promise<void> {
    if (this.isDecodingFrame) {
      return;
    }

    this.isDecodingFrame = true;
    const scale = 0.5;
    const scanWidth = Math.floor(videoWidth * scale);
    const scanHeight = Math.floor(videoHeight * scale);

    this.scanCanvas!.width = scanWidth;
    this.scanCanvas!.height = scanHeight;
    this.scanCtx!.drawImage(video, 0, 0, scanWidth, scanHeight);

    try {
      const imageData = this.scanCtx!.getImageData(0, 0, scanWidth, scanHeight);
      const result = await this.pythonWaveDecoder.decodeFrame(
        imageData.data,
        scanWidth,
        scanHeight
      );

      if (result) {
        this.applyDecoded(result);
        return;
      }

      this.clearDetection();
    } finally {
      this.isDecodingFrame = false;
    }
  }

  private applyDecoded(result: WaveDecodeResult): void {
    this.lastDetectedPreview = result.preview;
    this.waveAmplitudes = createOverlayAmplitudes(result.preview, 180);

    if (!this.isDetected()) {
      this.ngZone.run(() => this.isDetected.set(true));
    }

    const similarity = this.compareWithLoadedPreview(result.preview);
    if (similarity >= 0.7) {
      this.stopSynthesis();
      if (!this.usingSessionAudio || !this.audioService.isPlaying()) {
        this.audioService.play();
      }

      this.usingSessionAudio = true;
      if (this.playbackMode() !== 'session') {
        this.ngZone.run(() => {
          this.playbackMode.set('session');
          this.isPlayingAudio.set(true);
        });
      }
      return;
    }

    if (this.usingSessionAudio) {
      this.audioService.stop();
      this.usingSessionAudio = false;
    }

    this.startSynthesis(result);

    if (this.playbackMode() !== 'preview' || !this.isPlayingAudio()) {
      this.ngZone.run(() => {
        this.playbackMode.set('preview');
        this.isPlayingAudio.set(true);
      });
    }
  }

  private clearDetection(): void {
    this.waveAmplitudes = [];
    this.lastDetectedPreview = new Float32Array(0);
    this.stopSynthesis();

    if (this.usingSessionAudio) {
      this.audioService.stop();
      this.usingSessionAudio = false;
    }

    if (this.isDetected() || this.isPlayingAudio() || this.playbackMode() !== 'none') {
      this.ngZone.run(() => {
        this.isDetected.set(false);
        this.isPlayingAudio.set(false);
        this.playbackMode.set('none');
      });
    }
  }

  private startSynthesis(result: WaveDecodeResult): void {
    if (!this.audioCtx || !this.synthGainNode) {
      return;
    }

    // Skip regeneration if waveform hasn't changed significantly
    if (this.bufferSourceNode && this.lastBufferPreview.length === result.preview.length) {
      const sim = this.cosineSimilarity(this.lastBufferPreview, result.preview);
      if (sim > 0.92) {
        return;
      }
    }

    // Stop current playback cleanly
    if (this.bufferSourceNode) {
      try { this.bufferSourceNode.stop(); } catch { /* ok */ }
      this.bufferSourceNode.disconnect();
      this.bufferSourceNode = null;
    }

    // Create AudioBuffer from PCM samples
    const buffer = this.audioCtx.createBuffer(
      1,
      result.pcmSamples.length,
      result.sampleRate
    );
    buffer.getChannelData(0).set(result.pcmSamples);

    // Create looping source
    this.bufferSourceNode = this.audioCtx.createBufferSource();
    this.bufferSourceNode.buffer = buffer;
    this.bufferSourceNode.loop = true;
    this.bufferSourceNode.connect(this.synthGainNode);
    this.bufferSourceNode.start();

    this.lastBufferPreview = new Float32Array(result.preview);

    const targetGain = this.isMuted() ? 0 : 0.5;
    this.synthGainNode.gain.setTargetAtTime(
      targetGain,
      this.audioCtx.currentTime,
      0.08
    );
  }

  private stopSynthesis(): void {
    if (this.synthGainNode && this.audioCtx) {
      this.synthGainNode.gain.setTargetAtTime(
        0,
        this.audioCtx.currentTime,
        0.05
      );
    }

    if (this.bufferSourceNode) {
      try {
        this.bufferSourceNode.stop(
          (this.audioCtx?.currentTime ?? 0) + 0.1
        );
      } catch { /* ok */ }
      this.bufferSourceNode = null;
      this.lastBufferPreview = new Float32Array(0);
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let ea = 0;
    let eb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      ea += a[i] * a[i];
      eb += b[i] * b[i];
    }
    const denom = Math.sqrt(ea * eb) || 1;
    return dot / denom;
  }

  private compareWithLoadedPreview(preview: Float32Array): number {
    const loadedPreview = this.audioService.getLoadedPreview();
    if (!loadedPreview || loadedPreview.length !== preview.length) {
      return 0;
    }

    let best = -1;
    const maxShift = 48;

    for (let shift = -maxShift; shift <= maxShift; shift++) {
      let dot = 0;
      let energyA = 0;
      let energyB = 0;

      for (let index = 0; index < preview.length; index++) {
        const shiftedIndex = (index + shift + preview.length) % preview.length;
        const a = preview[index];
        const b = loadedPreview[shiftedIndex];
        dot += a * b;
        energyA += a * a;
        energyB += b * b;
      }

      const denom = Math.sqrt(energyA * energyB) || 1;
      best = Math.max(best, dot / denom);
    }

    return best;
  }

  private drawDetectedWave(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const amplitudes = this.waveAmplitudes;
    if (!amplitudes.length) return;

    const padX = width * 0.06;
    const centerY = height * 0.5;
    const drawWidth = width - padX * 2;
    const maxAmp = Math.max(...amplitudes, 0.01);
    const halfHeight = height * 0.18;

    ctx.shadowColor = '#4ade80';
    ctx.shadowBlur = 20;

    const gradient = ctx.createLinearGradient(padX, 0, padX + drawWidth, 0);
    gradient.addColorStop(0, 'rgba(74, 222, 128, 0.85)');
    gradient.addColorStop(0.5, 'rgba(34, 197, 94, 0.85)');
    gradient.addColorStop(1, 'rgba(74, 222, 128, 0.85)');

    // Preenchimento espelhado
    ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    for (let i = 0; i < amplitudes.length; i++) {
      const x = padX + (i / (amplitudes.length - 1)) * drawWidth;
      const h = (amplitudes[i] / maxAmp) * halfHeight;
      ctx.lineTo(x, centerY - h);
    }
    for (let i = amplitudes.length - 1; i >= 0; i--) {
      const x = padX + (i / (amplitudes.length - 1)) * drawWidth;
      const h = (amplitudes[i] / maxAmp) * halfHeight * 0.5;
      ctx.lineTo(x, centerY + h);
    }
    ctx.closePath();
    ctx.fill();

    // Linha superior
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < amplitudes.length; i++) {
      const x = padX + (i / (amplitudes.length - 1)) * drawWidth;
      const h = (amplitudes[i] / maxAmp) * halfHeight;
      if (i === 0) ctx.moveTo(x, centerY - h);
      else ctx.lineTo(x, centerY - h);
    }
    ctx.stroke();

    // Linha inferior (espelho sutil)
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    for (let i = 0; i < amplitudes.length; i++) {
      const x = padX + (i / (amplitudes.length - 1)) * drawWidth;
      const h = (amplitudes[i] / maxAmp) * halfHeight * 0.5;
      if (i === 0) ctx.moveTo(x, centerY + h);
      else ctx.lineTo(x, centerY + h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    ctx.shadowBlur = 0;

    // Linha central de referência
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    ctx.lineTo(padX + drawWidth, centerY);
    ctx.stroke();

    // Rótulo
    ctx.fillStyle = 'rgba(34, 197, 94, 0.92)';
    ctx.font = `bold ${width * 0.03}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(this.overlayLabel(), width / 2, height * 0.06);
  }

  private overlayLabel(): string {
    if (this.playbackMode() === 'session') {
      return '♪ ÁUDIO ORIGINAL';
    }

    if (this.playbackMode() === 'preview') {
      return '♪ ONDA DETECTADA';
    }

    return '';
  }
}
