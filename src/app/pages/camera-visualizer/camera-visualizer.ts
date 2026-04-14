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

  readonly isActive = signal(false);
  readonly isDetected = signal(false);
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

  // Escanear frame do vídeo para detectar pixels coloridos (onda)
  private scanFrame(video: HTMLVideoElement, vw: number, vh: number): void {
    // Reduzir resolução para performance
    const scale = 0.25;
    const sw = Math.floor(vw * scale);
    const sh = Math.floor(vh * scale);

    this.scanCanvas!.width = sw;
    this.scanCanvas!.height = sh;
    this.scanCtx!.drawImage(video, 0, 0, sw, sh);

    const imageData = this.scanCtx!.getImageData(0, 0, sw, sh);
    const pixels = imageData.data;

    // Detectar o centro da região com mais pixels verdes (a onda circular)
    let totalGreenX = 0;
    let totalGreenY = 0;
    let greenCount = 0;

    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        // Pixel é "verde neon" se G é dominante
        if (g > 80 && g > r * 1.5 && g > b * 1.5) {
          totalGreenX += x;
          totalGreenY += y;
          greenCount++;
        }
      }
    }

    if (greenCount < 50) {
      this.isDetected.set(false);
      this.waveAmplitudes = [];
      return;
    }

    this.isDetected.set(true);

    const cx = totalGreenX / greenCount;
    const cy = totalGreenY / greenCount;

    // Extrair amplitudes radiais ao redor do centro detectado
    const numPoints = 360;
    const amplitudes: number[] = [];

    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      let maxDist = 0;

      // Percorrer raio nesta direção
      for (let r = 5; r < Math.min(sw, sh) * 0.45; r += 1) {
        const px = Math.round(cx + Math.cos(angle) * r);
        const py = Math.round(cy + Math.sin(angle) * r);

        if (px < 0 || px >= sw || py < 0 || py >= sh) break;

        const idx = (py * sw + px) * 4;
        const rr = pixels[idx];
        const gg = pixels[idx + 1];
        const bb = pixels[idx + 2];

        if (gg > 80 && gg > rr * 1.5 && gg > bb * 1.5) {
          maxDist = r;
        }
      }

      amplitudes.push(maxDist);
    }

    // Suavizar amplitudes
    const smoothed: number[] = [];
    const smoothWindow = 5;
    for (let i = 0; i < amplitudes.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = -smoothWindow; j <= smoothWindow; j++) {
        const idx = (i + j + amplitudes.length) % amplitudes.length;
        sum += amplitudes[idx];
        count++;
      }
      smoothed.push(sum / count);
    }

    this.waveAmplitudes = smoothed;
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
    ctx.fillText('ONDA DETECTADA', cx, h * 0.06);

    // Ponto central
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#4ade80';
    ctx.fill();
  }
}
