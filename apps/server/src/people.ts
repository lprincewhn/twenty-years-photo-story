import { readFileSync } from "node:fs";

export interface PersonEntry {
  id: string;
  displayName: string;
  oldPhotoUrl: string;
  authorization: "placeholder" | "authorized";
  sourceNote: string;
}

const peoplePath = new URL("./people.json", import.meta.url);

export function loadPeople(): PersonEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(peoplePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("人物库格式无效");
  }
  return parsed as PersonEntry[];
}
