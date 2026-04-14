import { Component, inject, signal } from '@angular/core';
import { AudioVisualizerComponent } from '../../components/audio-visualizer/audio-visualizer';
import { AudioService } from '../../services/audio';

@Component({
  selector: 'app-home',
  imports: [AudioVisualizerComponent],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  protected readonly audioService = inject(AudioService);
  protected readonly waveformData = signal<Float32Array | null>(null);
  protected readonly isDragging = signal(false);

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      await this.loadAudioFile(file);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(): void {
    this.isDragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDragging.set(false);
    const file = event.dataTransfer?.files[0];
    if (file && file.type.startsWith('audio/')) {
      await this.loadAudioFile(file);
    }
  }

  togglePlay(): void {
    if (this.audioService.isPlaying()) {
      this.audioService.pause();
    } else {
      this.audioService.play();
    }
  }

  stop(): void {
    this.audioService.stop();
  }

  private async loadAudioFile(file: File): Promise<void> {
    const data = await this.audioService.loadFile(file);
    this.waveformData.set(data);
  }
}
