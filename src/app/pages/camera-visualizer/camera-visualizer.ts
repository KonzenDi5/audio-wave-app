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
import { PythonWaveDecoderService } from '../../services/python-wave-decoder';
import {
  PREVIEW_SAMPLE_COUNT,
  createOverlayAmplitudes,
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
  private readonly pythonWaveDecoder = inject(PythonWaveDecoderService);
  private mediaStream: MediaStream | null = null;
  private animationId = 0;
  private scanCanvas: HTMLCanvasElement | null = null;
  private scanCtx: CanvasRenderingContext2D | null = null;
  private usingSessionAudio = false;
  private lastDetectedPreview: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private isDecodingFrame = false;

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
      const pythonPreview = await this.pythonWaveDecoder.decodeFrame(
        imageData.data,
        scanWidth,
        scanHeight
      );
      const preview = pythonPreview ?? this.extractPreviewWave(imageData.data, scanWidth, scanHeight);

      if (preview) {
        this.applyPreview(preview);
        return;
      }

      this.clearDetection();
    } finally {
      this.isDecodingFrame = false;
    }
  }

  private applyPreview(preview: Float32Array): void {
    this.lastDetectedPreview = preview;
    this.waveAmplitudes = createOverlayAmplitudes(preview, 180);

    if (!this.isDetected()) {
      this.ngZone.run(() => this.isDetected.set(true));
    }

    const similarity = this.compareWithLoadedPreview(preview);
    if (similarity >= 0.9) {
      this.targetWavetable.fill(0);
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

    this.updateTargetWavetable(preview);
    this.baseFrequency = this.estimateBaseFrequency(preview);

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

  private extractPreviewWave(
    pixels: Uint8ClampedArray,
    width: number,
    height: number
  ): Float32Array | null {
    let totalX = 0;
    let totalY = 0;
    let pixelCount = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];

        if (!this.isReadableWavePixel(r, g, b)) {
          continue;
        }

        totalX += x;
        totalY += y;
        pixelCount += 1;
      }
    }

    if (pixelCount < 120) {
      return null;
    }

    const centerX = totalX / pixelCount;
    const centerY = totalY / pixelCount;
    const distances: number[] = [];

    for (let index = 0; index < PREVIEW_SAMPLE_COUNT; index++) {
      const angle = (index / PREVIEW_SAMPLE_COUNT) * Math.PI * 2 - Math.PI / 2;
      let farthestDistance = 0;

      for (let radius = 10; radius < Math.min(width, height) * 0.48; radius += 1) {
        const sampleX = Math.round(centerX + Math.cos(angle) * radius);
        const sampleY = Math.round(centerY + Math.sin(angle) * radius);

        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
          break;
        }

        const pixelIndex = (sampleY * width + sampleX) * 4;
        if (
          this.isReadableWavePixel(
            pixels[pixelIndex],
            pixels[pixelIndex + 1],
            pixels[pixelIndex + 2]
          )
        ) {
          farthestDistance = radius;
        }
      }

      distances.push(farthestDistance);
    }

    const validCount = distances.filter((distance) => distance > 0).length;
    if (validCount < PREVIEW_SAMPLE_COUNT * 0.72) {
      return null;
    }

    const smoothedDistances = this.gaussianSmooth(distances, 4);
    const meanRadius = smoothedDistances.reduce((sum, value) => sum + value, 0) / smoothedDistances.length;
    let peakDelta = 0;

    for (let index = 0; index < smoothedDistances.length; index++) {
      peakDelta = Math.max(peakDelta, Math.abs(smoothedDistances[index] - meanRadius));
    }

    if (peakDelta < 3) {
      return null;
    }

    const preview = new Float32Array(PREVIEW_SAMPLE_COUNT);
    for (let index = 0; index < smoothedDistances.length; index++) {
      preview[index] = this.clamp((smoothedDistances[index] - meanRadius) / peakDelta, -1, 1);
    }

    return preview;
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

  private isReadableWavePixel(r: number, g: number, b: number): boolean {
    return g > 72 && g > r * 1.18 && g > b * 1.08;
  }

  private gaussianSmooth(data: number[], radius: number): number[] {
    const result: number[] = [];
    const sigma = radius / 2;
    const weights: number[] = [];
    let weightSum = 0;

    for (let offset = -radius; offset <= radius; offset++) {
      const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
      weights.push(weight);
      weightSum += weight;
    }

    for (let index = 0; index < data.length; index++) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampleIndex = (index + offset + data.length) % data.length;
        sum += data[sampleIndex] * weights[offset + radius];
      }
      result.push(sum / weightSum);
    }

    return result;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
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
