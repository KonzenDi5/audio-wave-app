import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private startTime = 0;
  private pauseOffset = 0;
  private animationId = 0;

  readonly isPlaying = signal(false);
  readonly isLoaded = signal(false);
  readonly duration = signal(0);
  readonly currentTime = signal(0);
  readonly fileName = signal('');

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  async loadFile(file: File): Promise<Float32Array> {
    this.stop();

    const ctx = this.getContext();
    const arrayBuffer = await file.arrayBuffer();
    this.audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    this.duration.set(this.audioBuffer.duration);
    this.fileName.set(file.name);
    this.isLoaded.set(true);
    this.pauseOffset = 0;
    this.currentTime.set(0);

    return this.audioBuffer.getChannelData(0);
  }

  play(): void {
    if (!this.audioBuffer) return;

    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    this.destroySource();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.sourceNode.start(0, this.pauseOffset);
    this.startTime = ctx.currentTime - this.pauseOffset;
    this.isPlaying.set(true);

    this.trackTime();

    this.sourceNode.onended = () => {
      if (this.isPlaying()) {
        this.isPlaying.set(false);
        this.pauseOffset = 0;
        this.currentTime.set(0);
        cancelAnimationFrame(this.animationId);
      }
    };
  }

  pause(): void {
    if (!this.isPlaying()) return;
    const ctx = this.getContext();
    this.pauseOffset = ctx.currentTime - this.startTime;
    this.destroySource();
    this.isPlaying.set(false);
    cancelAnimationFrame(this.animationId);
  }

  stop(): void {
    this.destroySource();
    this.pauseOffset = 0;
    this.isPlaying.set(false);
    this.currentTime.set(0);
    cancelAnimationFrame(this.animationId);
  }

  getWaveData(): Uint8Array | null {
    if (!this.analyser || !this.dataArray) return null;
    this.analyser.getByteTimeDomainData(this.dataArray);
    return this.dataArray;
  }

  getFrequencyData(): Uint8Array | null {
    if (!this.analyser) return null;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  private trackTime(): void {
    const update = () => {
      if (!this.isPlaying()) return;
      const ctx = this.getContext();
      const t = ctx.currentTime - this.startTime;
      this.currentTime.set(Math.min(t, this.duration()));
      this.animationId = requestAnimationFrame(update);
    };
    this.animationId = requestAnimationFrame(update);
  }

  private destroySource(): void {
    try {
      this.sourceNode?.stop();
    } catch { /* já estava parado */ }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
  }

  formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}