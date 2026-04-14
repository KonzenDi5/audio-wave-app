import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  input,
  effect,
  inject
} from '@angular/core';
import { AudioService } from '../../services/audio';

@Component({
  selector: 'app-audio-visualizer',
  templateUrl: './audio-visualizer.html',
  styleUrl: './audio-visualizer.scss'
})
export class AudioVisualizerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('waveformCanvas') waveformCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('liveCanvas') liveCanvasRef!: ElementRef<HTMLCanvasElement>;

  waveformData = input<Float32Array | null>(null);

  private audioService = inject(AudioService);
  private animationId = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const data = this.waveformData();
      if (data && this.waveformCanvasRef) {
        this.drawStaticWaveform(data);
      }
    });
  }

  ngAfterViewInit(): void {
    this.setupResize();
    const data = this.waveformData();
    if (data) {
      this.drawStaticWaveform(data);
    }
    this.animateLive();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver?.disconnect();
  }

  private setupResize(): void {
    const container = this.waveformCanvasRef?.nativeElement?.parentElement;
    if (!container) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas(this.waveformCanvasRef.nativeElement);
      this.resizeCanvas(this.liveCanvasRef.nativeElement);
      const data = this.waveformData();
      if (data) {
        this.drawStaticWaveform(data);
      }
    });
    this.resizeObserver.observe(container);
  }

  private resizeCanvas(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  private drawStaticWaveform(data: Float32Array): void {
    const canvas = this.waveformCanvasRef.nativeElement;
    this.resizeCanvas(canvas);
    const ctx = canvas.getContext('2d')!;
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);

    // Draw center line
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Draw waveform
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = Math.ceil(data.length / w);
    for (let i = 0; i < w; i++) {
      const idx = Math.floor(i * step);
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step && idx + j < data.length; j++) {
        const val = data[idx + j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const yMin = ((1 + min) / 2) * h;
      const yMax = ((1 + max) / 2) * h;
      ctx.moveTo(i, yMin);
      ctx.lineTo(i, yMax);
    }
    ctx.stroke();

    // Draw playback progress overlay
    if (this.audioService.isLoaded() && this.audioService.duration() > 0) {
      const progress = this.audioService.currentTime() / this.audioService.duration();
      const xPos = progress * w;

      // Highlight played portion
      ctx.fillStyle = 'rgba(34, 197, 94, 0.1)';
      ctx.fillRect(0, 0, xPos, h);

      // Playhead line
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xPos, 0);
      ctx.lineTo(xPos, h);
      ctx.stroke();
    }
  }

  private animateLive(): void {
    const canvas = this.liveCanvasRef.nativeElement;
    this.resizeCanvas(canvas);

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const ctx = canvas.getContext('2d')!;

      ctx.clearRect(0, 0, w, h);

      // Update static waveform playhead
      const wfData = this.waveformData();
      if (wfData && this.audioService.isPlaying()) {
        this.drawStaticWaveform(wfData);
      }

      if (!this.audioService.isPlaying()) return;

      const data = this.audioService.getWaveData();
      if (!data) return;

      // Draw real-time waveform
      ctx.fillStyle = 'rgba(2, 6, 23, 0.3)';
      ctx.fillRect(0, 0, w, h);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#22c55e';
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 8;
      ctx.beginPath();

      const sliceWidth = w / data.length;
      let x = 0;

      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = (v * h) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Draw frequency bars at bottom
      const freqData = this.audioService.getFrequencyData();
      if (freqData) {
        const barCount = 64;
        const barWidth = w / barCount;
        const step = Math.floor(freqData.length / barCount);

        for (let i = 0; i < barCount; i++) {
          const value = freqData[i * step] / 255;
          const barHeight = value * h * 0.4;

          const gradient = ctx.createLinearGradient(0, h, 0, h - barHeight);
          gradient.addColorStop(0, 'rgba(34, 197, 94, 0.6)');
          gradient.addColorStop(1, 'rgba(34, 197, 94, 0.05)');

          ctx.fillStyle = gradient;
          ctx.fillRect(i * barWidth + 1, h - barHeight, barWidth - 2, barHeight);
        }
      }
    };

    draw();
  }
}
