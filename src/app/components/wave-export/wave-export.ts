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

    // Onda circular
    this.drawCircularWave(ctx, w, h, data, style);

    // Faixa horizontal com a onda legível pela câmera
    this.drawHorizontalWaveStrip(ctx, w, h, data, style);

    // Título
    const name = this.fileName() || 'Audio Wave';
    ctx.textAlign = 'center';
    if (style === 'minimal') {
      ctx.fillStyle = '#1e293b';
    } else {
      ctx.fillStyle = '#ffffff';
    }
    ctx.font = `bold ${w * 0.032}px Inter, sans-serif`;
    ctx.fillText(name, w / 2, h * 0.935);

    // Marca d'água
    ctx.font = `${w * 0.017}px Inter, sans-serif`;
    ctx.fillStyle = style === 'minimal' ? '#94a3b8' : 'rgba(255,255,255,0.3)';
    ctx.fillText('Audio Wave App', w / 2, h * 0.975);
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
    const guideColor = style === 'minimal' ? '#22c55e' : '#4ade80';

    const padX = w * 0.06;
    const stripTop = h * 0.76;
    const stripHeight = h * 0.13;
    const stripBottom = stripTop + stripHeight;
    const centerY = stripTop + stripHeight / 2;
    const drawWidth = w - padX * 2;
    const halfAmplitude = stripHeight * 0.42;

    ctx.save();

    // Fundo escuro da faixa
    ctx.fillStyle = style === 'minimal' ? 'rgba(241, 245, 249, 0.95)' : 'rgba(0, 0, 0, 0.82)';
    ctx.fillRect(padX - 6, stripTop - 6, drawWidth + 12, stripHeight + 12);

    // Linhas-guia superior e inferior (detecção pela câmera)
    ctx.strokeStyle = guideColor;
    ctx.lineWidth = Math.max(2, w * 0.003);
    ctx.beginPath();
    ctx.moveTo(padX, stripTop);
    ctx.lineTo(padX + drawWidth, stripTop);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(padX, stripBottom);
    ctx.lineTo(padX + drawWidth, stripBottom);
    ctx.stroke();

    // Linha central de referência (sutil)
    ctx.strokeStyle = style === 'minimal' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(74, 222, 128, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    ctx.lineTo(padX + drawWidth, centerY);
    ctx.stroke();

    // Marcadores de alinhamento nos cantos
    ctx.fillStyle = guideColor;
    const ms = w * 0.008;
    ctx.fillRect(padX - ms, stripTop - ms, ms * 2, ms * 2);
    ctx.fillRect(padX + drawWidth - ms, stripTop - ms, ms * 2, ms * 2);
    ctx.fillRect(padX - ms, stripBottom - ms, ms * 2, ms * 2);
    ctx.fillRect(padX + drawWidth - ms, stripBottom - ms, ms * 2, ms * 2);

    // Glow
    if (style !== 'minimal') {
      ctx.shadowColor = guideColor;
      ctx.shadowBlur = 12;
    }

    // Preenchimento superior
    const gradient = ctx.createLinearGradient(padX, stripTop, padX + drawWidth, stripTop);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);

    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    for (let i = 0; i < samples.length; i++) {
      const x = padX + (i / (samples.length - 1)) * drawWidth;
      const y = centerY - Math.max(0, samples[i]) * halfAmplitude;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(padX + drawWidth, centerY);
    ctx.closePath();
    ctx.fillStyle = style === 'minimal' ? 'rgba(34, 197, 94, 0.12)' : `${colors[0]}1A`;
    ctx.fill();

    // Preenchimento inferior
    ctx.beginPath();
    ctx.moveTo(padX, centerY);
    for (let i = 0; i < samples.length; i++) {
      const x = padX + (i / (samples.length - 1)) * drawWidth;
      const y = centerY - Math.min(0, samples[i]) * halfAmplitude;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(padX + drawWidth, centerY);
    ctx.closePath();
    ctx.fillStyle = style === 'minimal' ? 'rgba(34, 197, 94, 0.12)' : `${colors[0]}1A`;
    ctx.fill();

    // Linha principal da onda
    ctx.strokeStyle = guideColor;
    ctx.lineWidth = Math.max(3, w * 0.004);
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = padX + (i / (samples.length - 1)) * drawWidth;
      const y = centerY - samples[i] * halfAmplitude;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  private drawCircularWave(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    data: Float32Array,
    style: WaveStyle
  ): void {
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = w * 0.2;
    const maxAmplitude = w * 0.145;
    const points = 360;
    const step = Math.floor(data.length / points);

    const colors = this.styles.find((s) => s.key === style)!.colors;

    // Efeito de brilho
    if (style !== 'minimal') {
      ctx.shadowColor = colors[0];
      ctx.shadowBlur = 30;
    }

    // Onda circular preenchida
    const gradient = ctx.createLinearGradient(cx - baseRadius, cy, cx + baseRadius, cy);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);

    // Onda espelhada (externa)
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2 - Math.PI / 2;
        const idx = (i * step) % data.length;

        let amplitude = 0;
        for (let j = 0; j < step && idx + j < data.length; j++) {
          amplitude += Math.abs(data[idx + j]);
        }
        amplitude = (amplitude / step) * maxAmplitude;

        const r = pass === 0 ? baseRadius + amplitude : baseRadius - amplitude * 0.5;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      if (pass === 0) {
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2;
        ctx.stroke();

        if (style !== 'minimal') {
          ctx.fillStyle =
            style === 'neon'
              ? 'rgba(34, 197, 94, 0.05)'
              : style === 'gradient'
              ? 'rgba(249, 115, 22, 0.05)'
              : 'rgba(6, 182, 212, 0.05)';
          ctx.fill();
        }
      } else {
        ctx.strokeStyle = style === 'minimal' ? colors[1] : `${colors[1]}88`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.shadowBlur = 0;

    // Círculo central
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 0.3, 0, Math.PI * 2);
    if (style === 'minimal') {
      ctx.fillStyle = '#f1f5f9';
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    } else {
      const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius * 0.3);
      innerGrad.addColorStop(0, `${colors[0]}33`);
      innerGrad.addColorStop(1, `${colors[0]}11`);
      ctx.fillStyle = innerGrad;
      ctx.fill();
      ctx.strokeStyle = `${colors[0]}66`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Ícone de onda no centro
    ctx.strokeStyle = style === 'minimal' ? colors[0] : colors[0];
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const iconSize = baseRadius * 0.15;
    const bars = [0.5, 0.8, 1, 0.8, 0.5];
    const barSpacing = iconSize * 0.5;
    const startX = cx - (bars.length - 1) * barSpacing * 0.5;
    bars.forEach((h_ratio, i) => {
      const bx = startX + i * barSpacing;
      const bh = iconSize * h_ratio;
      ctx.beginPath();
      ctx.moveTo(bx, cy - bh);
      ctx.lineTo(bx, cy + bh);
      ctx.stroke();
    });
  }

  private isMobile(): boolean {
    return /Android|iPhone|iPad/i.test(navigator.userAgent);
  }
}
