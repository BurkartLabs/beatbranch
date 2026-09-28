export declare class Transport {
  constructor(count: number, mode?: "mix" | "ab");
  muted: boolean[];
  solo: boolean[];
  master: number;
  playing: boolean;
  offset: number;
  startedAt: number;
  side: number;
  position(now: number): number;
  play(now: number): number;
  pause(now: number): number;
  seek(now: number, seconds: number): number;
  choose(now: number, side: number): number;
  toggleMute(i: number): void;
  toggleSolo(i: number): void;
  gains(): number[];
}
export declare function clock(seconds: number): string;
