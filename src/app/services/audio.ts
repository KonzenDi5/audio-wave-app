import { Injectable, signal } from '@angular/core';

import { createWaveId } from '../shared/wave-payload';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private startTime = 0;
  private pauseOffset = 0;
  private animationId = 0;
  private muted = false;

  readonly isPlaying = signal(false);
  readonly isLoaded = signal(false);
  readonly duration = signal(0);
  readonly currentTime = signal(0);
  readonly fileName = signal('');
  readonly loadedWaveId = signal('');

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    if (!this.masterGain) {
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;
      this.masterGain.connect(this.audioContext.destination);
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
    this.loadedWaveId.set(createWaveId(this.audioBuffer.getChannelData(0)));
    this.pauseOffset = 0;
    this.currentTime.set(0);

    return this.audioBuffer.getChannelData(0);
  }

  playLoadedByWaveId(waveId: string): boolean {
    if (!this.audioBuffer || this.loadedWaveId() !== waveId) {
      return false;
    }

    this.play();
    return true;
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
    this.analyser.connect(this.masterGain!);

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

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : 1;
    }
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
    this.analyser?.disconnect();
    this.analyser = null;
    this.sourceNode = null;
  }

  formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
