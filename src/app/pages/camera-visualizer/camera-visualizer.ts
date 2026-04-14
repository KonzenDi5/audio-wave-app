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

@Component({
  selector: 'app-camera-visualizer',
  imports: [RouterLink],
  templateUrl: './camera-visualizer.html',
  styleUrl: './camera-visualizer.scss',
})
export class CameraVisualizerPage implements OnDestroy {
  @ViewChild('videoElement', { static: true }) videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlayCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private ngZone = inject(NgZone);
  private mediaStream: MediaStream | null = null;
  private animationId = 0;
  private scanCanvas: HTMLCanvasElement | null = null;
  private scanCtx: CanvasRenderingContext2D | null = null;

  // Dados extraídos da imagem capturada pela câmera
  private waveAmplitudes: number[] = [];
  private detectedHue = 120; // Matiz dominante (verde por padrão)

  // Síntese de áudio via wavetable
  private audioCtx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private readonly WAVETABLE_SIZE = 2048;
  private currentWavetable = new Float32Array(2048);
  private targetWavetable = new Float32Array(2048);
  private playbackPhase = 0;
  private baseFrequency = 220; // Hz (A3)
  private fadeGain = 0; // 0 = silêncio, 1 = volume total

  readonly isActive = signal(false);
  readonly isDetected = signal(false);
  readonly isPlayingAudio = signal(false);
  readonly isMuted = signal(false);
  readonly hasError = signal('');
  readonly facingMode = signal<'environment' | 'user'>('environment');

  async startCamera(): Promise<void> {
    this.hasError.set('');

    try {
      // Só câmera, sem microfone
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

      // Canvas auxiliar para ler pixels do vídeo
      this.scanCanvas = document.createElement('canvas');
      this.scanCtx = this.scanCanvas.getContext('2d', { willReadFrequently: true })!;

      // Inicializar contexto de áudio para síntese em tempo real
      await this.initAudio();

      this.isActive.set(true);
      this.ngZone.runOutsideAngular(() => this.animate());
    } catch (err) {
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;

      const detalhe = err instanceof Error ? err.message : String(err);
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permissão negada. Habilite a câmera nas configurações.'
          : `Erro ao iniciar câmera: ${detalhe}`;
      this.hasError.set(msg);
    }
  }

  stopCamera(): void {
    cancelAnimationFrame(this.animationId);
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.scanCanvas = null;
    this.scanCtx = null;
    this.destroyAudio();
    this.isActive.set(false);
    this.isDetected.set(false);
  }

  toggleCamera(): void {
    this.facingMode.set(this.facingMode() === 'environment' ? 'user' : 'environment');
    if (this.isActive()) {
      this.stopCamera();
      this.startCamera();
    }
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

    if (blob) {
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        const file = new File([blob], 'wave-scan.png', { type: 'image/png' });
        await navigator.share({ files: [file], title: 'Wave Scan' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wave-scan-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  }

  // Inicializar contexto de áudio para síntese via wavetable
  private async initAudio(): Promise<void> {
    try {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      await this.audioCtx.resume();

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 0.5;
      this.gainNode.connect(this.audioCtx.destination);

      this.scriptNode = this.audioCtx.createScriptProcessor(2048, 0, 1);
      this.playbackPhase = 0;
      this.fadeGain = 0;
      this.currentWavetable.fill(0);
      this.targetWavetable.fill(0);

      const sampleRate = this.audioCtx.sampleRate;

      this.scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const output = event.outputBuffer.getChannelData(0);
        const wt = this.currentWavetable;
        const target = this.targetWavetable;

        // Morph suave: wavetable atual → alvo (evita cliques entre frames)
        for (let s = 0; s < wt.length; s++) {
          wt[s] += (target[s] - wt[s]) * 0.03;
        }

        // Fade in/out suave (evita cliques ao detectar/perder onda)
        const targetFade = this.isDetected() ? 1 : 0;

        // Incremento de fase para frequência desejada
        const phaseInc = (this.WAVETABLE_SIZE * this.baseFrequency) / sampleRate;

        for (let i = 0; i < output.length; i++) {
          // Fade gradual (~50ms de rampa)
          this.fadeGain += (targetFade - this.fadeGain) * 0.0008;

          // Leitura com interpolação linear da wavetable
          const idx = Math.floor(this.playbackPhase);
          const frac = this.playbackPhase - idx;
          const s0 = wt[idx % this.WAVETABLE_SIZE];
          const s1 = wt[(idx + 1) % this.WAVETABLE_SIZE];

          output[i] = (s0 + (s1 - s0) * frac) * this.fadeGain;

          this.playbackPhase += phaseInc;
          if (this.playbackPhase >= this.WAVETABLE_SIZE) {
            this.playbackPhase -= this.WAVETABLE_SIZE;
          }
        }
      };

      this.scriptNode.connect(this.gainNode);
    } catch (err) {
      console.warn('Não foi possível inicializar áudio:', err);
    }
  }

  // Parar e limpar recursos de áudio
  private destroyAudio(): void {
    this.scriptNode?.disconnect();
    this.scriptNode = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    this.audioCtx?.close();
    this.audioCtx = null;
    this.currentWavetable.fill(0);
    this.targetWavetable.fill(0);
    this.playbackPhase = 0;
    this.fadeGain = 0;
    this.isPlayingAudio.set(false);
  }

  // Alternar mudo/desmudo
  toggleMute(): void {
    this.isMuted.set(!this.isMuted());
    if (this.gainNode) {
      this.gainNode.gain.value = this.isMuted() ? 0 : 0.5;
    }
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }

  private animate(): void {
    const canvas = this.canvasRef.nativeElement;
    const video = this.videoRef.nativeElement;
    let frameCount = 0;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      if (!this.scanCanvas || !this.scanCtx) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      // Escanear a cada 3 frames (performance)
      frameCount++;
      if (frameCount % 3 === 0) {
        this.scanFrame(video, vw, vh);
      }

      // Ajustar canvas de overlay
      const rect = video.getBoundingClientRect();
      if (canvas.width !== rect.width * 2 || canvas.height !== rect.height * 2) {
        canvas.width = rect.width * 2;
        canvas.height = rect.height * 2;
      }

      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      if (this.waveAmplitudes.length > 0) {
        this.drawDetectedWave(ctx, w, h);
      }
    };

    draw();
  }

  // Escanear frame do vídeo para detectar onda circular colorida
  private scanFrame(video: HTMLVideoElement, vw: number, vh: number): void {
    // Resolução mais alta para melhor precisão
    const scale = 0.4;
    const sw = Math.floor(vw * scale);
    const sh = Math.floor(vh * scale);

    this.scanCanvas!.width = sw;
    this.scanCanvas!.height = sh;
    this.scanCtx!.drawImage(video, 0, 0, sw, sh);

    const imageData = this.scanCtx!.getImageData(0, 0, sw, sh);
    const pixels = imageData.data;

    // Passo 1: Histograma de matiz para detectar cor dominante da onda
    const hueBuckets = new Float64Array(12); // 12 faixas de 30° cada
    const pixelHues: Float32Array = new Float32Array(sw * sh);
    const pixelIsBright = new Uint8Array(sw * sh);

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);

        // Ignorar pixels escuros ou dessaturados (fundo)
        if (maxC < 50 || (maxC - minC) < 20) continue;

        const hue = this.rgbToHue(r, g, b);
        const idx = y * sw + x;
        pixelHues[idx] = hue;
        pixelIsBright[idx] = 1;

        const bucket = Math.floor(hue / 30) % 12;
        hueBuckets[bucket]++;
      }
    }

    // Encontrar matiz dominante
    let maxBucket = 0, maxCount = 0;
    for (let i = 0; i < 12; i++) {
      if (hueBuckets[i] > maxCount) {
        maxCount = hueBuckets[i];
        maxBucket = i;
      }
    }

    if (maxCount < 30) {
      this.isDetected.set(false);
      this.waveAmplitudes = [];
      if (this.isPlayingAudio()) {
        this.ngZone.run(() => this.isPlayingAudio.set(false));
      }
      return;
    }

    this.detectedHue = maxBucket * 30 + 15;

    // Passo 2: Criar mapa binário de pixels da onda (filtrados por matiz)
    const waveMap = new Uint8Array(sw * sh);
    let totalX = 0, totalY = 0, waveCount = 0;
    const hueCenter = this.detectedHue;

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const idx = y * sw + x;
        if (!pixelIsBright[idx]) continue;

        let hueDiff = Math.abs(pixelHues[idx] - hueCenter);
        if (hueDiff > 180) hueDiff = 360 - hueDiff;

        if (hueDiff < 50) {
          waveMap[idx] = 1;
          totalX += x;
          totalY += y;
          waveCount++;
        }
      }
    }

    if (waveCount < 40) {
      this.isDetected.set(false);
      this.waveAmplitudes = [];
      if (this.isPlayingAudio()) {
        this.ngZone.run(() => this.isPlayingAudio.set(false));
      }
      return;
    }

    this.isDetected.set(true);

    const cx = totalX / waveCount;
    const cy = totalY / waveCount;

    // Passo 3: Extrair amplitudes radiais com alta resolução
    const numPoints = 720;
    const amplitudes: number[] = [];
    const maxR = Math.min(sw, sh) * 0.45;

    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      let outerDist = 0;

      // Raio com passo de 0.5px para sub-pixel
      for (let r = 3; r < maxR; r += 0.5) {
        const px = Math.round(cx + Math.cos(angle) * r);
        const py = Math.round(cy + Math.sin(angle) * r);

        if (px < 0 || px >= sw || py < 0 || py >= sh) break;

        if (waveMap[py * sw + px]) {
          outerDist = r;
        }
      }

      amplitudes.push(outerDist);
    }

    // Passo 4: Suavizar com kernel gaussiano
    const smoothed = this.gaussianSmooth(amplitudes, 9);
    this.waveAmplitudes = smoothed;

    // Passo 5: Converter para wavetable de áudio
    this.updateTargetWavetable(smoothed);

    if (!this.isPlayingAudio()) {
      this.ngZone.run(() => this.isPlayingAudio.set(true));
    }
  }

  // Converter amplitudes detectadas em wavetable normalizada [-1, 1]
  private updateTargetWavetable(amplitudes: number[]): void {
    const maxA = Math.max(...amplitudes);
    const minA = Math.min(...amplitudes);
    const range = maxA - minA || 1;
    const mid = (maxA + minA) / 2;

    // Resample com interpolação linear para WAVETABLE_SIZE
    for (let i = 0; i < this.WAVETABLE_SIZE; i++) {
      const t = (i / this.WAVETABLE_SIZE) * amplitudes.length;
      const idx = Math.floor(t);
      const frac = t - idx;
      const a0 = amplitudes[idx % amplitudes.length];
      const a1 = amplitudes[(idx + 1) % amplitudes.length];
      const interpolated = a0 + (a1 - a0) * frac;

      this.targetWavetable[i] = (interpolated - mid) / (range / 2);
    }

    // Remover offset DC residual
    let sum = 0;
    for (let i = 0; i < this.WAVETABLE_SIZE; i++) sum += this.targetWavetable[i];
    const dc = sum / this.WAVETABLE_SIZE;
    for (let i = 0; i < this.WAVETABLE_SIZE; i++) this.targetWavetable[i] -= dc;

    // Normalizar pico a [-1, 1]
    let peak = 0;
    for (let i = 0; i < this.WAVETABLE_SIZE; i++) {
      peak = Math.max(peak, Math.abs(this.targetWavetable[i]));
    }
    if (peak > 0) {
      for (let i = 0; i < this.WAVETABLE_SIZE; i++) {
        this.targetWavetable[i] /= peak;
      }
    }
  }

  // Suavização gaussiana para dados circulares
  private gaussianSmooth(data: number[], radius: number): number[] {
    const result: number[] = [];
    const sigma = radius / 2;
    const weights: number[] = [];
    let weightSum = 0;

    for (let j = -radius; j <= radius; j++) {
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      weights.push(w);
      weightSum += w;
    }

    for (let i = 0; i < data.length; i++) {
      let s = 0;
      for (let j = -radius; j <= radius; j++) {
        const idx = (i + j + data.length) % data.length;
        s += data[idx] * weights[j + radius];
      }
      result.push(s / weightSum);
    }

    return result;
  }

  // Converter RGB para matiz (0-360°)
  private rgbToHue(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;

    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;

    h *= 60;
    if (h < 0) h += 360;
    return h;
  }

  // Desenhar a onda detectada como overlay
  private drawDetectedWave(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const amps = this.waveAmplitudes;
    const cx = w / 2;
    const cy = h / 2;

    // Normalizar amplitudes para escala da tela
    const maxAmp = Math.max(...amps, 1);
    const displayRadius = Math.min(w, h) * 0.35;

    // Brilho
    ctx.shadowColor = '#4ade80';
    ctx.shadowBlur = 25;

    // Onda detectada
    const gradient = ctx.createLinearGradient(cx - displayRadius, cy, cx + displayRadius, cy);
    gradient.addColorStop(0, 'rgba(74, 222, 128, 0.9)');
    gradient.addColorStop(0.5, 'rgba(34, 197, 94, 0.9)');
    gradient.addColorStop(1, 'rgba(74, 222, 128, 0.9)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    for (let i = 0; i <= amps.length; i++) {
      const angle = (i / amps.length) * Math.PI * 2 - Math.PI / 2;
      const normalizedAmp = (amps[i % amps.length] / maxAmp);
      const r = displayRadius * 0.3 + normalizedAmp * displayRadius * 0.7;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // Preenchimento sutil
    ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
    ctx.fill();

    ctx.shadowBlur = 0;

    // Indicador de detecção no topo
    ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
    ctx.font = `bold ${w * 0.03}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    const rotulo = this.isPlayingAudio() ? '♪ REPRODUZINDO...' : 'ONDA DETECTADA';
    ctx.fillText(rotulo, cx, h * 0.06);

    // Ponto central
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  }
}
