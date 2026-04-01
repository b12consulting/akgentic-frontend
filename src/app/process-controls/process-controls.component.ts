import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActorMessageService } from '../services/message.service';

@Component({
  selector: 'app-process-controls',
  templateUrl: './process-controls.component.html',
  styleUrls: ['./process-controls.component.css'],
  imports: [CommonModule],
})
export class ProcessControlsComponent {
  messageService: ActorMessageService = inject(ActorMessageService);

  numberOfMessages: number = 0;
  currentMessageIndex: number = 0;
  isPaused: boolean = false;

  togglePause() {
    if (this.isPaused) {
      this.play();
    } else {
      this.pause();
    }
  }

  pause() {
    this.messageService.pauseClicked();
    this.isPaused = true;
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }

  play() {
    this.messageService.playClicked();
    this.isPaused = false;
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }
  back() {
    this.messageService.backClicked();
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }
  backward() {
    this.messageService.backwardClicked();
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }
  next() {
    this.messageService.nextClicked();
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }
  forward() {
    this.messageService.forwardClicked();
    [this.numberOfMessages, this.currentMessageIndex] =
      this.messageService.controlStatus();
  }
}
