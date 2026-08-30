import { readFileSync } from "node:fs";
import { z } from "zod";

const personSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
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

const peopleSchema = z.array(personSchema).superRefine((people, context) => {
  const ids = new Set<string>();
  const photoFiles = new Set<string>();
  people.forEach((person, index) => {
    if (ids.has(person.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "人物 id 不能重复",
      });
    }
    if (photoFiles.has(person.oldPhotoFile)) {
      context.addIssue({
        code: "custom",
        path: [index, "oldPhotoFile"],
        message: "人物照片文件不能重复使用",
      });
    }
    ids.add(person.id);
    photoFiles.add(person.oldPhotoFile);
  });
});

export type PersonEntry = z.infer<typeof personSchema>;

const peoplePath = new URL("./people.json", import.meta.url);

export function parsePeople(input: unknown): PersonEntry[] {
  return peopleSchema.parse(input);
}

export function loadPeople(): PersonEntry[] {
  return parsePeople(JSON.parse(readFileSync(peoplePath, "utf8")));
}
