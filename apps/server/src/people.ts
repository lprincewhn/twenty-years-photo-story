import { readFileSync } from "node:fs";
import { z } from "zod";

const personSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  oldPhotoUrl: z.string().startsWith("/api/people/").endsWith("/photo"),
  oldPhotoFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  authorization: z.enum(["placeholder", "authorized"]),
  sourceNote: z.string().min(1),
}).superRefine((person, context) => {
  if (person.oldPhotoUrl !== `/api/people/${person.id}/photo`) {
    context.addIssue({
      code: "custom",
      path: ["oldPhotoUrl"],
      message: "oldPhotoUrl 必须指向人物自己的受控照片端点",
    });
  }
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
