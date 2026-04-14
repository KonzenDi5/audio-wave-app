import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  input,
  signal,
  effect,
} from '@angular/core';

import { PREVIEW_SAMPLE_COUNT, sampleWaveform } from '../../shared/wave-payload';

type WaveStyle = 'neon' | 'gradient' | 'minimal' | 'ocean';

@Component({
  selector: 'app-wave-export',
  templateUrl: './wave-export.html',
  styleUrl: './wave-export.scss',
})
export class WaveExportComponent implements AfterViewInit {
  @ViewChild('previewCanvas') previewCanvasRef!: ElementRef<HTMLCanvasElement>;

  waveformData = input<Float32Array | null>(null);
  fileName = input<string>('');

  readonly selectedStyle = signal<WaveStyle>('neon');
  readonly isExporting = signal(false);

  private viewReady = false;

  constructor() {
    effect(() => {
      const _style = this.selectedStyle();
      const _data = this.waveformData();
      if (this.viewReady) {
        this.renderPreview();
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.renderPreview();
  }

  private renderPreview(): void {
    const canvas = this.previewCanvasRef?.nativeElement;
    const data = this.waveformData();
    if (!canvas || !data) return;

    const rect = canvas.getBoundingClientRect();
    const size = Math.max(rect.width, 300);
    canvas.width = size * 2;
    canvas.height = size * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(2, 2);
    this.renderWaveImage(ctx, size, size, data);
  }

  readonly styles: { key: WaveStyle; label: string; colors: string[] }[] = [
    { key: 'neon', label: 'Neon', colors: ['#22c55e', '#4ade80'] },
    { key: 'gradient', label: 'Sunset', colors: ['#f97316', '#ec4899'] },
    { key: 'minimal', label: 'Minimal', colors: ['#e2e8f0', '#94a3b8'] },
    { key: 'ocean', label: 'Ocean', colors: ['#06b6d4', '#8b5cf6'] },
  ];

  selectStyle(style: WaveStyle): void {
    this.selectedStyle.set(style);
  }

  async exportImage(): Promise<void> {
    const data = this.waveformData();
    if (!data) return;

    this.isExporting.set(true);

    try {
      const canvas = document.createElement('canvas');
      const scale = 2;
      canvas.width = 1080 * scale;
      canvas.height = 1080 * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);

      this.renderWaveImage(ctx, 1080, 1080, data);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      );

      if (blob) {
        if (navigator.share && this.isMobile()) {
          const file = new File([blob], 'audio-wave.png', { type: 'image/png' });
          await navigator.share({ files: [file], title: 'Audio Wave' });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `audio-wave-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }
      }
    } finally {
      this.isExporting.set(false);
    }
  }

  private renderWaveImage(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    data: Float32Array
  ): void {
    const style = this.selectedStyle();
    const colors = this.styles.find((s) => s.key === style)!.colors;

    // Fundo
    if (style === 'minimal') {
      ctx.fillStyle = '#ffffff';
    } else {
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
      if (style === 'neon') {
        bgGrad.addColorStop(0, '#0a1a0f');
        bgGrad.addColorStop(1, '#020617');
      } else if (style === 'gradient') {
        bgGrad.addColorStop(0, '#1a0a1e');
        bgGrad.addColorStop(1, '#0a0617');
      } else {
        bgGrad.addColorStop(0, '#0a1520');
        bgGrad.addColorStop(1, '#020617');
      }
      ctx.fillStyle = bgGrad;
    }
    ctx.fillRect(0, 0, w, h);

    // Ícone de onda no centro superior
    const iconY = h * 0.18;
    ctx.save();
    if (style !== 'minimal') {
      ctx.shadowColor = colors[0];
      ctx.shadowBlur = 40;
    }
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = Math.max(3, w * 0.004);
    ctx.lineCap = 'round';
    const iconBars = [0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3];
    const iconH = w * 0.06;
    const iconSpacing = w * 0.022;
    const iconStartX = w / 2 - (iconBars.length - 1) * iconSpacing * 0.5;
    iconBars.forEach((ratio, i) => {
      const bx = iconStartX + i * iconSpacing;
      const bh = iconH * ratio;
      ctx.beginPath();
      ctx.moveTo(bx, iconY - bh);
      ctx.lineTo(bx, iconY + bh);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
    ctx.restore();

    // Título
    const name = this.fileName() || 'Audio Wave';
    ctx.textAlign = 'center';
    ctx.fillStyle = style === 'minimal' ? '#1e293b' : '#ffffff';
    ctx.font = `bold ${w * 0.038}px Inter, sans-serif`;
    ctx.fillText(name, w / 2, h * 0.30);

    // Faixa horizontal com a onda legível pela câmera
    this.drawHorizontalWaveStrip(ctx, w, h, data, style);

    // Marca d'água
    ctx.textAlign = 'center';
    ctx.font = `${w * 0.018}px Inter, sans-serif`;
    ctx.fillStyle = style === 'minimal' ? '#94a3b8' : 'rgba(255,255,255,0.3)';
    ctx.fillText('Audio Wave App', w / 2, h * 0.96);
  }

  private drawHorizontalWaveStrip(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    data: Float32Array,
    style: WaveStyle
  ): void {
    const samples = sampleWaveform(data, PREVIEW_SAMPLE_COUNT);
    const colors = this.styles.find((s) => s.key === style)!.colors;
    const guideColor = '#22c55e';

    const padX = w * 0.05;
    const stripTop = h * 0.38;
    const stripHeight = h * 0.48;
    const stripBottom = stripTop + stripHeight;
    const centerY = stripTop + stripHeight / 2;
    const drawWidth = w - padX * 2;
    const halfAmplitude = stripHeight * 0.45;

    ctx.save();

    // Fundo da faixa
    ctx.fillStyle = style === 'minimal' ? 'rgba(241, 245, 249, 0.97)' : 'rgba(0, 0, 0, 0.55)';
    const radius = w * 0.015;
    this.roundRect(ctx, padX - 10, stripTop - 10, drawWidth + 20, stripHeight + 20, radius);
    ctx.fill();

    // Linhas-guia verde para detecção pela câmera
    ctx.strokeStyle = guideColor;
    ctx.lineWidth = Math.max(3, w * 0.0035);
    ctx.beginPath();
    ctx.moveTo(padX, stripTop);
    ctx.lineTo(padX + drawWidth, stripTop);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padX, stripBottom);
    ctx.lineTo(padX + drawWidth, stripBottom);
    ctx.stroke();

    // Marcadores de canto verdes
    ctx.fillStyle = guideColor;
    const ms = w * 0.007;
    ctx.fillRect(padX - ms, stripTop - ms, ms * 2, ms * 2);
    ctx.fillRect(padX + drawWidth - ms, stripTop - ms, ms * 2, ms * 2);
    ctx.fillRect(padX - ms, stripBottom - ms, ms * 2, ms * 2);
    ctx.fillRect(padX + drawWidth - ms, stripBottom - ms, ms * 2, ms * 2);

    // Linha central sutil
    ctx.strokeStyle = style === 'minimal' ? `${colors[0]}22` : `${colors[0]}18`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    ctx.lineTo(padX + drawWidth, centerY);
    ctx.stroke();

    // Barras com gradiente do tema + codificação verde
    const barCount = PREVIEW_SAMPLE_COUNT;
    const barWidth = drawWidth / barCount;
    const gap = Math.max(0.5, barWidth * 0.15);
    const actualBarWidth = Math.max(1, barWidth - gap);
    const minBarH = Math.max(2, w * 0.003);

    for (let i = 0; i < barCount; i++) {
      const x = padX + i * barWidth + gap * 0.5;
      const sample = samples[i];
      const absAmp = Math.abs(sample);
      const barH = Math.max(minBarH, absAmp * halfAmplitude);

      // Gradiente vertical do tema para a barra visível
      const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(0.5, colors[1]);
      grad.addColorStop(1, colors[0]);
      ctx.fillStyle = grad;
      ctx.fillRect(x, centerY - barH, actualBarWidth, barH * 2);

      // Sobreposição verde codificando amplitude — é o que o Python lê
      const encoded = Math.round((sample + 1) * 0.5 * 215 + 40);
      const g = Math.max(40, Math.min(255, encoded));
      ctx.fillStyle = `rgba(0, ${g}, 0, 0.55)`;
      ctx.fillRect(x, centerY - barH, actualBarWidth, barH * 2);
    }
    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private isMobile(): boolean {
    return /Android|iPhone|iPad/i.test(navigator.userAgent);
  }
}
