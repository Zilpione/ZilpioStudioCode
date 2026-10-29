export type OpenAiCodexDetectionMode = 'conservative' | 'chatHeuristic';

interface OpenAiCodexLogCandidate {
  readonly id: number;
  readonly startedAt: number;
  lastActivityAt: number;
  legacyStreamEvents: number;
  sawReadState: boolean;
  readonly sawTurnStart: boolean;
}

export interface OpenAiCodexLogDetectorOptions {
  readonly quietMs?: number;
  readonly maxGapMs?: number;
  readonly maxCandidateMs?: number;
  readonly minLegacyStreamEvents?: number;
  readonly alertCooldownMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const turnDiffMarker = 'requestKind=turn-diff-capture-complete';
const legacyStreamMarker = 'method=thread-stream-state-changed';
const readStateMarker = 'method=thread-read-state-changed';
const turnStartMarker = 'Reasoning summary turn-start config resolved';
const turnActivityMarker = 'Reasoning summary item completed';

/**
 * Interprets the private Codex extension log format. The detector supports both
 * the legacy stream/read-state sequence and the turn-start/read-state sequence
 * introduced by newer OpenAI Codex extension builds.
 */
export class OpenAiCodexLogDetector {
  private candidate: OpenAiCodexLogCandidate | undefined;
  private quietTimer: unknown;
  private candidateId = 0;
  private lastAlertAt = 0;

  private readonly quietMs: number;
  private readonly maxGapMs: number;
  private readonly maxCandidateMs: number;
  private readonly minLegacyStreamEvents: number;
  private readonly alertCooldownMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(
    private readonly onCompletion: (source: string) => void,
    options: OpenAiCodexLogDetectorOptions = {}
  ) {
    this.quietMs = options.quietMs ?? 3000;
    this.maxGapMs = options.maxGapMs ?? 7000;
    this.maxCandidateMs = options.maxCandidateMs ?? 180000;
    this.minLegacyStreamEvents = options.minLegacyStreamEvents ?? 6;
    this.alertCooldownMs = options.alertCooldownMs ?? 12000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  inspect(chunk: string, mode: OpenAiCodexDetectionMode): void {
    if (!chunk) {
      return;
    }

    if (chunk.includes(turnDiffMarker)) {
      this.resetCandidate();
      this.emitCompletion('OpenAI Codex turn diff completed');
      return;
    }

    if (mode !== 'chatHeuristic') {
      return;
    }

    for (const line of chunk.split(/\r?\n/)) {
      if (line.includes(turnStartMarker)) {
        this.trackTurnStart();
      } else if (line.includes(legacyStreamMarker)) {
        this.trackLegacyStreamActivity();
      } else if (line.includes(turnActivityMarker)) {
        this.trackTurnActivity();
      } else if (line.includes(readStateMarker)) {
        this.trackReadState();
      }
    }
  }

  reset(): void {
    this.resetCandidate();
    this.lastAlertAt = 0;
  }

  dispose(): void {
    this.resetCandidate();
  }

  private trackTurnStart(): void {
    const now = this.now();
    this.resetCandidate();
    this.candidate = {
      id: ++this.candidateId,
      startedAt: now,
      lastActivityAt: now,
      legacyStreamEvents: 0,
      sawReadState: false,
      sawTurnStart: true
    };
  }

  private trackLegacyStreamActivity(): void {
    const now = this.now();
    if (
      !this.candidate ||
      this.candidate.sawTurnStart ||
      now - this.candidate.lastActivityAt > this.maxGapMs ||
      now - this.candidate.startedAt > this.maxCandidateMs
    ) {
      this.resetCandidate();
      this.candidate = {
        id: ++this.candidateId,
        startedAt: now,
        lastActivityAt: now,
        legacyStreamEvents: 0,
        sawReadState: false,
        sawTurnStart: false
      };
    }

    this.candidate.lastActivityAt = now;
    this.candidate.legacyStreamEvents += 1;
    if (this.candidate.sawReadState) {
      this.scheduleQuietCheck(this.candidate.id);
    }
  }

  private trackTurnActivity(): void {
    const candidate = this.candidate;
    const now = this.now();
    if (!candidate?.sawTurnStart || now - candidate.startedAt > this.maxCandidateMs) {
      return;
    }

    candidate.lastActivityAt = now;
    if (candidate.sawReadState) {
      this.scheduleQuietCheck(candidate.id);
    }
  }

  private trackReadState(): void {
    const candidate = this.candidate;
    const now = this.now();
    if (!candidate || now - candidate.startedAt > this.maxCandidateMs) {
      return;
    }

    const legacyCandidateIsValid =
      !candidate.sawTurnStart &&
      candidate.legacyStreamEvents >= this.minLegacyStreamEvents &&
      now - candidate.lastActivityAt <= this.maxGapMs;
    if (!candidate.sawTurnStart && !legacyCandidateIsValid) {
      return;
    }

    candidate.sawReadState = true;
    candidate.lastActivityAt = now;
    this.scheduleQuietCheck(candidate.id);
  }

  private scheduleQuietCheck(candidateId: number): void {
    if (this.quietTimer !== undefined) {
      this.clearTimer(this.quietTimer);
    }
    this.quietTimer = this.setTimer(() => this.completeCandidate(candidateId), this.quietMs);
  }

  private completeCandidate(candidateId: number): void {
    this.quietTimer = undefined;
    const candidate = this.candidate;
    if (!candidate || candidate.id !== candidateId || !candidate.sawReadState) {
      return;
    }

    const now = this.now();
    const quietFor = now - candidate.lastActivityAt;
    if (quietFor < this.quietMs - 50) {
      this.scheduleQuietCheck(candidate.id);
      return;
    }

    const source = candidate.sawTurnStart
      ? 'OpenAI Codex turn completed'
      : 'OpenAI Codex chat stream settled';
    this.resetCandidate();
    this.emitCompletion(source);
  }

  private emitCompletion(source: string): void {
    const now = this.now();
    if (now - this.lastAlertAt < this.alertCooldownMs) {
      return;
    }
    this.lastAlertAt = now;
    this.onCompletion(source);
  }

  private resetCandidate(): void {
    this.candidate = undefined;
    if (this.quietTimer !== undefined) {
      this.clearTimer(this.quietTimer);
      this.quietTimer = undefined;
    }
  }
}
