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
import jsQR from 'jsqr';

import { AudioService } from '../../services/audio';
import {
  createOverlayAmplitudes,
  decodeWavePayload,
  type WavePayload,
} from '../../shared/wave-payload';

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
  private mediaStream: MediaStream | null = null;
  private animationId = 0;
  private scanCanvas: HTMLCanvasElement | null = null;
  private scanCtx: CanvasRenderingContext2D | null = null;
  private qrMissCount = 0;
  private activeWaveId = '';
  private usingSessionAudio = false;

  // Dados exibidos no overlay a partir do payload lido da imagem
  private waveAmplitudes: number[] = [];

  // Síntese de fallback via wavetable para quando o áudio original não está carregado
  private audioCtx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private readonly wavetableSize = 2048;
  private currentWavetable = new Float32Array(this.wavetableSize);
  private targetWavetable = new Float32Array(this.wavetableSize);
  private playbackPhase = 0;
  private baseFrequency = 220;
  private fadeGain = 0;

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
    if (this.gainNode) {
      this.gainNode.gain.value = nextMuted ? 0 : 0.5;
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

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.isMuted() ? 0 : 0.5;
      this.gainNode.connect(this.audioCtx.destination);

      this.scriptNode = this.audioCtx.createScriptProcessor(2048, 0, 1);
      this.currentWavetable.fill(0);
      this.targetWavetable.fill(0);
      this.playbackPhase = 0;
      this.fadeGain = 0;

      const sampleRate = this.audioCtx.sampleRate;
      this.scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const output = event.outputBuffer.getChannelData(0);

        for (let index = 0; index < this.currentWavetable.length; index++) {
          this.currentWavetable[index] +=
            (this.targetWavetable[index] - this.currentWavetable[index]) * 0.04;
        }

        const targetFade = this.playbackMode() === 'preview' ? 1 : 0;
        const phaseIncrement = (this.wavetableSize * this.baseFrequency) / sampleRate;

        for (let index = 0; index < output.length; index++) {
          this.fadeGain += (targetFade - this.fadeGain) * 0.0012;

          const position = Math.floor(this.playbackPhase);
          const fraction = this.playbackPhase - position;
          const sampleA = this.currentWavetable[position % this.wavetableSize];
          const sampleB = this.currentWavetable[(position + 1) % this.wavetableSize];

          output[index] = (sampleA + (sampleB - sampleA) * fraction) * this.fadeGain;

          this.playbackPhase += phaseIncrement;
          if (this.playbackPhase >= this.wavetableSize) {
            this.playbackPhase -= this.wavetableSize;
          }
        }
      };

      this.scriptNode.connect(this.gainNode);
    } catch (err) {
      console.warn('Não foi possível inicializar áudio:', err);
    }
  }

  private destroyAudio(): void {
    this.scriptNode?.disconnect();
    this.scriptNode = null;
    this.gainNode?.disconnect();
    this.gainNode = null;

    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }

    this.currentWavetable.fill(0);
    this.targetWavetable.fill(0);
    this.playbackPhase = 0;
    this.fadeGain = 0;
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
        this.scanFrame(video, videoWidth, videoHeight);
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

  private scanFrame(video: HTMLVideoElement, videoWidth: number, videoHeight: number): void {
    const scale = 0.7;
    const scanWidth = Math.floor(videoWidth * scale);
    const scanHeight = Math.floor(videoHeight * scale);

    this.scanCanvas!.width = scanWidth;
    this.scanCanvas!.height = scanHeight;
    this.scanCtx!.drawImage(video, 0, 0, scanWidth, scanHeight);

    const imageData = this.scanCtx!.getImageData(0, 0, scanWidth, scanHeight);
    const qrCode = jsQR(imageData.data, scanWidth, scanHeight, {
      inversionAttempts: 'attemptBoth',
    });

    if (qrCode) {
      const payload = decodeWavePayload(qrCode.data);
      if (payload) {
        this.applyPayload(payload);
        this.qrMissCount = 0;
        return;
      }
    }

    this.qrMissCount += 1;
    if (this.qrMissCount >= 12) {
      this.clearDetection();
    }
  }

  private applyPayload(payload: WavePayload): void {
    const isNewWave = this.activeWaveId !== payload.waveId;
    this.activeWaveId = payload.waveId;
    this.waveAmplitudes = createOverlayAmplitudes(payload.preview, 180);

    if (!this.isDetected()) {
      this.ngZone.run(() => this.isDetected.set(true));
    }

    const canPlayOriginal = this.audioService.loadedWaveId() === payload.waveId;
    if (canPlayOriginal) {
      this.targetWavetable.fill(0);
      if (!this.usingSessionAudio || isNewWave || !this.audioService.isPlaying()) {
        this.audioService.playLoadedByWaveId(payload.waveId);
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

    this.updateTargetWavetable(payload.preview);
    this.baseFrequency = this.estimateBaseFrequency(payload.preview);

    if (this.playbackMode() !== 'preview' || !this.isPlayingAudio()) {
      this.ngZone.run(() => {
        this.playbackMode.set('preview');
        this.isPlayingAudio.set(true);
      });
    }
  }

  private clearDetection(): void {
    this.qrMissCount = 0;
    this.activeWaveId = '';
    this.waveAmplitudes = [];
    this.targetWavetable.fill(0);

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

  private updateTargetWavetable(preview: Float32Array): void {
    if (!preview.length) {
      this.targetWavetable.fill(0);
      return;
    }

    for (let index = 0; index < this.wavetableSize; index++) {
      const position = (index / this.wavetableSize) * preview.length;
      const baseIndex = Math.floor(position);
      const fraction = position - baseIndex;
      const sampleA = preview[baseIndex % preview.length];
      const sampleB = preview[(baseIndex + 1) % preview.length];
      this.targetWavetable[index] = sampleA + (sampleB - sampleA) * fraction;
    }

    let dcOffset = 0;
    for (let index = 0; index < this.wavetableSize; index++) {
      dcOffset += this.targetWavetable[index];
    }
    dcOffset /= this.wavetableSize;

    let peak = 0;
    for (let index = 0; index < this.wavetableSize; index++) {
      this.targetWavetable[index] -= dcOffset;
      peak = Math.max(peak, Math.abs(this.targetWavetable[index]));
    }

    if (peak > 0) {
      for (let index = 0; index < this.wavetableSize; index++) {
        this.targetWavetable[index] /= peak;
      }
    }
  }

  private estimateBaseFrequency(preview: Float32Array): number {
    if (preview.length < 8) {
      return 220;
    }

    let zeroCrossings = 0;
    for (let index = 1; index < preview.length; index++) {
      const previous = preview[index - 1];
      const current = preview[index];
      if ((previous <= 0 && current > 0) || (previous >= 0 && current < 0)) {
        zeroCrossings += 1;
      }
    }

    const normalized = zeroCrossings / preview.length;
    const estimated = 140 + normalized * 320;
    return Math.min(440, Math.max(140, estimated));
  }

  private drawDetectedWave(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const amplitudes = this.waveAmplitudes;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxAmplitude = Math.max(...amplitudes, 1);
    const displayRadius = Math.min(width, height) * 0.35;

    ctx.shadowColor = '#4ade80';
    ctx.shadowBlur = 25;

    const gradient = ctx.createLinearGradient(
      centerX - displayRadius,
      centerY,
      centerX + displayRadius,
      centerY
    );
    gradient.addColorStop(0, 'rgba(74, 222, 128, 0.9)');
    gradient.addColorStop(0.5, 'rgba(34, 197, 94, 0.9)');
    gradient.addColorStop(1, 'rgba(74, 222, 128, 0.9)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    for (let index = 0; index <= amplitudes.length; index++) {
      const angle = (index / amplitudes.length) * Math.PI * 2 - Math.PI / 2;
      const normalizedAmplitude = amplitudes[index % amplitudes.length] / maxAmplitude;
      const radius = displayRadius * 0.3 + normalizedAmplitude * displayRadius * 0.7;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(34, 197, 94, 0.92)';
    ctx.font = `bold ${width * 0.03}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(this.overlayLabel(), centerX, height * 0.06);

    ctx.beginPath();
    ctx.arc(centerX, centerY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  }

  private overlayLabel(): string {
    if (this.playbackMode() === 'session') {
      return '♪ ÁUDIO ORIGINAL';
    }

    if (this.playbackMode() === 'preview') {
      return '♪ PRÉVIA EMBUTIDA';
    }

    return 'QR DETECTADO';
  }
}
