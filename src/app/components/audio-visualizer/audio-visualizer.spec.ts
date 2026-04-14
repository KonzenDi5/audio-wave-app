import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AudioVisualizer } from './audio-visualizer';

describe('AudioVisualizer', () => {
  let component: AudioVisualizer;
  let fixture: ComponentFixture<AudioVisualizer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AudioVisualizer],
    }).compileComponents();

    fixture = TestBed.createComponent(AudioVisualizer);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
