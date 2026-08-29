import { readFileSync } from "node:fs";
import { z } from "zod";

const personSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  oldPhotoUrl: z.string().min(1),
  authorization: z.enum(["placeholder", "authorized"]),
  sourceNote: z.string().min(1),
});

const peopleSchema = z.array(personSchema).min(1);

export type PersonEntry = z.infer<typeof personSchema>;

const peoplePath = new URL("./people.json", import.meta.url);

export function parsePeople(input: unknown): PersonEntry[] {
  return peopleSchema.parse(input);
}

export function loadPeople(): PersonEntry[] {
  return parsePeople(JSON.parse(readFileSync(peoplePath, "utf8")));
}
