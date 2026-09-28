// The curated lists a project is described with (AB#2747): DAWs, genres with their subgenres, states. One source, read
// by the form, the validator and the pages (T-003): a value not in these lists is refused, never stored.

export const DAWS = [
  { id: "fl-studio", name: "FL Studio", ext: [".flp", ".zip"] },
  { id: "ableton", name: "Ableton Live", ext: [".als"] },
  { id: "logic", name: "Logic Pro", ext: [".logicx", ".zip"] },
  { id: "reaper", name: "Reaper", ext: [".rpp"] },
  { id: "studio-one", name: "Studio One", ext: [".song"] },
  { id: "bitwig", name: "Bitwig Studio", ext: [".bwproject"] },
  { id: "other", name: "Other", ext: [] }
] as const;
export type DawId = (typeof DAWS)[number]["id"];
export const DAW_IDS = DAWS.map((d) => d.id) as [DawId, ...DawId[]];
export const dawName = (id: string): string => DAWS.find((d) => d.id === id)?.name ?? id;

export const STATES = [
  { id: "idea", name: "Idea" },
  { id: "sketch", name: "Sketch" },
  { id: "arrangement", name: "Arrangement" },
  { id: "mixing", name: "Mixing" },
  { id: "mastering", name: "Mastering" },
  { id: "released", name: "Released" }
] as const;
export type StateId = (typeof STATES)[number]["id"];
export const STATE_IDS = STATES.map((s) => s.id) as [StateId, ...StateId[]];
export const stateName = (id: string): string => STATES.find((s) => s.id === id)?.name ?? id;

export const VISIBILITIES = [
  { id: "public", name: "Public", says: "Anyone can find it and listen." },
  { id: "unlisted", name: "Unlisted", says: "Anyone with the link can open it; it is not listed anywhere." },
  { id: "private", name: "Private", says: "Only you and the people you invite." }
] as const;
export type Visibility = (typeof VISIBILITIES)[number]["id"];
export const VISIBILITY_IDS = VISIBILITIES.map((v) => v.id) as [Visibility, ...Visibility[]];

/** Genres and subgenres: extensible here, in one place. The empty subgenre means "just the genre". */
export const GENRES: Record<string, readonly string[]> = {
  "Hip hop": ["Trap", "Boom bap", "Drill", "Lo-fi", "Phonk", "Plugg"],
  "R&B": ["Contemporary", "Neo soul", "Alternative R&B"],
  Pop: ["Dance pop", "Synth pop", "Indie pop", "Hyperpop"],
  House: ["Deep house", "Tech house", "Progressive house", "UK garage", "Afro house"],
  Techno: ["Melodic techno", "Industrial", "Minimal", "Hard techno"],
  "Drum and bass": ["Liquid", "Neurofunk", "Jungle", "Jump up"],
  Dubstep: ["Riddim", "Melodic dubstep", "Brostep"],
  Trance: ["Uplifting", "Psytrance", "Progressive trance"],
  Ambient: ["Drone", "Downtempo", "Chillout"],
  Electronic: ["IDM", "Breakbeat", "Electro", "Synthwave", "Future bass"],
  Rock: ["Indie", "Alternative", "Metal", "Punk"],
  Jazz: ["Fusion", "Nu jazz"],
  Soundtrack: ["Cinematic", "Game", "Trailer"],
  Other: []
};
export const GENRE_NAMES = Object.keys(GENRES);

/** Whether the genre and subgenre are a pair the catalogue knows; the subgenre may be empty. */
export function knownGenre(genre: string, subgenre: string): boolean {
  if (genre === "") return subgenre === "";
  const subs = GENRES[genre];
  return subs !== undefined && (subgenre === "" || subs.includes(subgenre));
}
