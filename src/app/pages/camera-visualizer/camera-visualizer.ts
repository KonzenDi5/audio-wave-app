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
  // ViewChild estático: o vídeo e o canvas estão sempre no DOM (não dentro de @if)
  @ViewChild('videoElement', { static: true }) videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlayCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private ngZone = inject(NgZone);
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationId = 0;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private freqArray: Uint8Array<ArrayBuffer> | null = null;

  readonly isActive = signal(false);
  readonly hasError = signal('');
  readonly facingMode = signal<'environment' | 'user'>('environment');
  readonly visualMode = signal<'wave' | 'bars' | 'circle'>('circle');

  async startCamera(): Promise<void> {
    this.hasError.set('');

    try {
      // Solicitar câmera e microfone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: this.facingMode(),
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });

      // Atribuir stream ao vídeo (o elemento já existe no DOM)
      const video = this.videoRef.nativeElement;
      video.srcObject = this.mediaStream;

      // Aguardar o vídeo começar a renderizar
      await new Promise<void>((resolve) => {
        const aoIniciar = () => {
          video.removeEventListener('playing', aoIniciar);
          resolve();
        };
        video.addEventListener('playing', aoIniciar);

        // Tentar dar play programaticamente (fallback para autoplay)
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch(() => {
            // play() pode falhar em iOS — autoplay deve funcionar mesmo assim
          });
        }

        // Segurança: resolver após 4s caso o evento 'playing' não dispare
        setTimeout(() => resolve(), 4000);
      });

      // Configurar análise de áudio separadamente (câmera funciona mesmo sem)
      try {
        this.audioContext = new AudioContext();
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        const source = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        source.connect(this.analyser);
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
        this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      } catch {
        // Análise de áudio falhou — câmera continua, só sem overlay de ondas
        this.analyser = null;
      }

      this.isActive.set(true);
      this.ngZone.runOutsideAngular(() => this.animate());
    } catch (err) {
      // Parar tracks caso a inicialização falhe
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;

      const detalhe = err instanceof Error ? err.message : String(err);
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permissão negada. Habilite câmera e microfone nas configurações.'
          : `Erro ao iniciar câmera: ${detalhe}`;
      this.hasError.set(msg);
    }
  }

  stopCamera(): void {
    cancelAnimationFrame(this.animationId);
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.analyser = null;
    this.isActive.set(false);
  }

  toggleCamera(): void {
    this.facingMode.set(this.facingMode() === 'environment' ? 'user' : 'environment');
    if (this.isActive()) {
      this.stopCamera();
      this.startCamera();
    }
  }

  setVisualMode(mode: 'wave' | 'bars' | 'circle'): void {
    this.visualMode.set(mode);
  }

  async captureSnapshot(): Promise<void> {
    const canvas = this.canvasRef.nativeElement;
    const video = this.videoRef.nativeElement;

    // Criar canvas composto (vídeo + overlay)
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = video.videoWidth || 1080;
    exportCanvas.height = video.videoHeight || 1920;
    const ctx = exportCanvas.getContext('2d')!;

    // Desenhar frame do vídeo
    ctx.drawImage(video, 0, 0, exportCanvas.width, exportCanvas.height);

    // Desenhar overlay das ondas
    ctx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      exportCanvas.toBlob(resolve, 'image/png')
    );

    if (blob) {
      if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        const file = new File([blob], 'wave-camera.png', { type: 'image/png' });
        await navigator.share({ files: [file], title: 'Wave Camera' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wave-camera-${Date.now()}.png`;
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

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      if (!this.analyser || !this.dataArray || !this.freqArray) return;

      // Ajustar canvas ao tamanho do vídeo
      const rect = video.getBoundingClientRect();
      if (canvas.width !== rect.width * 2 || canvas.height !== rect.height * 2) {
        canvas.width = rect.width * 2;
        canvas.height = rect.height * 2;
        canvas.getContext('2d')!.scale(2, 2);
      }

      const ctx = canvas.getContext('2d')!;
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      this.analyser!.getByteTimeDomainData(this.dataArray!);
      this.analyser!.getByteFrequencyData(this.freqArray!);

      const mode = this.visualMode();
      if (mode === 'wave') {
        this.drawWave(ctx, w, h);
      } else if (mode === 'bars') {
        this.drawBars(ctx, w, h);
      } else {
        this.drawCircle(ctx, w, h);
      }
    };

    draw();
  }

  private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const data = this.dataArray!;
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, 'rgba(34, 197, 94, 0.9)');
    gradient.addColorStop(0.5, 'rgba(74, 222, 128, 0.9)');
    gradient.addColorStop(1, 'rgba(34, 197, 94, 0.9)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 3;
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur = 20;
    ctx.beginPath();

    const sliceWidth = w / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private drawBars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const freq = this.freqArray!;
    const barCount = 48;
    const barWidth = w / barCount;
    const step = Math.floor(freq.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const value = freq[i * step] / 255;
      const barHeight = value * h * 0.6;

      const gradient = ctx.createLinearGradient(0, h, 0, h - barHeight);
      gradient.addColorStop(0, 'rgba(34, 197, 94, 0.8)');
      gradient.addColorStop(0.5, 'rgba(74, 222, 128, 0.6)');
      gradient.addColorStop(1, 'rgba(34, 197, 94, 0.1)');

      ctx.fillStyle = gradient;
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 6;

      const x = i * barWidth + 2;
      const bw = barWidth - 4;
      const radius = 3;

      ctx.beginPath();
      ctx.moveTo(x + radius, h - barHeight);
      ctx.lineTo(x + bw - radius, h - barHeight);
      ctx.quadraticCurveTo(x + bw, h - barHeight, x + bw, h - barHeight + radius);
      ctx.lineTo(x + bw, h);
      ctx.lineTo(x, h);
      ctx.lineTo(x, h - barHeight + radius);
      ctx.quadraticCurveTo(x, h - barHeight, x + radius, h - barHeight);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  private drawCircle(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const data = this.dataArray!;
    const freq = this.freqArray!;
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.2;
    const maxAmp = Math.min(w, h) * 0.15;
    const points = 180;
    const step = Math.floor(data.length / points);

    // Brilho externo
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur = 30;

    const gradient = ctx.createLinearGradient(cx - baseRadius, cy, cx + baseRadius, cy);
    gradient.addColorStop(0, 'rgba(34, 197, 94, 0.9)');
    gradient.addColorStop(1, 'rgba(74, 222, 128, 0.9)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2 - Math.PI / 2;
      const idx = (i * step) % data.length;
      const v = (data[idx] - 128) / 128;
      const r = baseRadius + v * maxAmp;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // Preenchimento interno
    ctx.fillStyle = 'rgba(34, 197, 94, 0.05)';
    ctx.fill();

    ctx.shadowBlur = 0;

    // Anel de frequências
    const freqPoints = 64;
    const freqStep = Math.floor(freq.length / freqPoints);
    for (let i = 0; i < freqPoints; i++) {
      const angle = (i / freqPoints) * Math.PI * 2 - Math.PI / 2;
      const value = freq[i * freqStep] / 255;
      const innerR = baseRadius * 1.3;
      const outerR = innerR + value * maxAmp * 0.8;

      ctx.strokeStyle = `rgba(74, 222, 128, ${0.3 + value * 0.5})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
      ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
      ctx.stroke();
    }
  }
}
