export const MAIN = "main";

export function ideaName(branch: string): string {
  return branch === MAIN ? "Main version" : branch;
}

export function ideaLabel(branch: string): string {
  return branch === MAIN ? "the Main version" : `the idea “${branch}”`;
}

export const KIND_WORDS = {
  project: { one: "Project file", hint: "The file your music program saves." },
  bounce: { one: "Full song", hint: "The whole song as one audio file (WAV, FLAC or MP3)." },
  stem: { one: "Instrument track", hint: "One audio file per instrument: drums, bass, vocals..." },
  samples: { one: "Samples zip", hint: "The zip of sounds your project uses." }
} as const;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
