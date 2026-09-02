import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const azureIdSchema = z.string().uuid().nullable().default(null);

export const faceBoxSchema = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const photoMemberSchema = z.object({
  personId: identifierSchema,
  faceBox: faceBoxSchema.nullable(),
  azurePersistedFaceId: azureIdSchema,
});

const libraryPhotoSchema = z.object({
  id: identifierSchema,
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/svg+xml"]),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  sourceNote: z.string().min(1),
  members: z.array(photoMemberSchema).min(1),
});

const personSchema = z.object({
  id: identifierSchema,
  displayName: z.string().min(1),
  photoId: identifierSchema,
  oldPhotoUrl: z.string().startsWith("/api/people/").endsWith("/photo"),
  authorization: z.enum(["placeholder", "authorized"]),
  sourceNote: z.string().min(1),
  azurePersonId: azureIdSchema,
}).superRefine((person, context) => {
  if (person.oldPhotoUrl !== `/api/people/${person.id}/photo`) {
    context.addIssue({
      code: "custom",
      path: ["oldPhotoUrl"],
      message: "oldPhotoUrl 必须指向人物自己的受控照片端点",
    });
  }
});

const peopleLibrarySchema = z.object({
  schemaVersion: z.literal(2),
  photos: z.array(libraryPhotoSchema),
  people: z.array(personSchema),
}).superRefine((library, context) => {
  const peopleById = new Map<string, number>();
  const azurePersonIds = new Set<string>();
  library.people.forEach((person, index) => {
    if (peopleById.has(person.id)) {
      context.addIssue({ code: "custom", path: ["people", index, "id"], message: "人物 id 不能重复" });
    }
    peopleById.set(person.id, index);
    if (person.azurePersonId) {
      if (azurePersonIds.has(person.azurePersonId)) {
        context.addIssue({ code: "custom", path: ["people", index, "azurePersonId"], message: "Azure personId 不能重复" });
      }
      azurePersonIds.add(person.azurePersonId);
    }
  });

  const photosById = new Map<string, number>();
  const photoFiles = new Set<string>();
  const persistedFaceIds = new Set<string>();
  library.photos.forEach((photo, photoIndex) => {
    if (photosById.has(photo.id)) {
      context.addIssue({ code: "custom", path: ["photos", photoIndex, "id"], message: "照片 id 不能重复" });
    }
    photosById.set(photo.id, photoIndex);
    if (photoFiles.has(photo.file)) {
      context.addIssue({ code: "custom", path: ["photos", photoIndex, "file"], message: "照片文件只能对应一个照片实体" });
    }
    photoFiles.add(photo.file);
    const memberIds = new Set<string>();
    const faceBoxes = new Set<string>();
    photo.members.forEach((member, memberIndex) => {
      const path = ["photos", photoIndex, "members", memberIndex] as (string | number)[];
      if (memberIds.has(member.personId)) {
        context.addIssue({ code: "custom", path: [...path, "personId"], message: "同一照片不能重复登记人物" });
      }
      memberIds.add(member.personId);
      if (member.azurePersistedFaceId) {
        if (persistedFaceIds.has(member.azurePersistedFaceId)) {
          context.addIssue({ code: "custom", path: [...path, "azurePersistedFaceId"], message: "Azure persistedFaceId 不能重复" });
        }
        persistedFaceIds.add(member.azurePersistedFaceId);
      }
      const personIndex = peopleById.get(member.personId);
      if (personIndex === undefined) {
        context.addIssue({ code: "custom", path: [...path, "personId"], message: "照片成员必须存在于人物列表" });
      } else if (library.people[personIndex]?.photoId !== photo.id) {
        context.addIssue({ code: "custom", path: [...path, "personId"], message: "照片成员与人物 photoId 必须双向一致" });
      }
      if (member.faceBox) {
        const boxKey = `${member.faceBox.left},${member.faceBox.top},${member.faceBox.width},${member.faceBox.height}`;
        if (faceBoxes.has(boxKey)) {
          context.addIssue({ code: "custom", path: [...path, "faceBox"], message: "同一张脸不能登记给多个人物" });
        }
        faceBoxes.add(boxKey);
        if (photo.width === null || photo.height === null) {
          context.addIssue({ code: "custom", path: [...path, "faceBox"], message: "有 faceBox 的照片必须记录宽高" });
        } else if (
          member.faceBox.left + member.faceBox.width > photo.width ||
          member.faceBox.top + member.faceBox.height > photo.height
        ) {
          context.addIssue({ code: "custom", path: [...path, "faceBox"], message: "faceBox 超出照片边界" });
        }
      }
    });
  });

  library.people.forEach((person, personIndex) => {
    const photoIndex = photosById.get(person.photoId);
    if (photoIndex === undefined) {
      context.addIssue({ code: "custom", path: ["people", personIndex, "photoId"], message: "人物 photoId 必须引用现有照片" });
    } else if (!library.photos[photoIndex]?.members.some((member) => member.personId === person.id)) {
      context.addIssue({ code: "custom", path: ["people", personIndex, "photoId"], message: "人物必须出现在所引用照片的 members 中" });
    }
  });
});

const legacyPersonSchema = z.object({
  id: identifierSchema,
  displayName: z.string().min(1),
  oldPhotoUrl: z.string(),
  oldPhotoFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  authorization: z.enum(["placeholder", "authorized"]),
  sourceNote: z.string().min(1),
}).superRefine((person, context) => {
  if (person.oldPhotoUrl !== `/api/people/${person.id}/photo`) {
    context.addIssue({ code: "custom", path: ["oldPhotoUrl"], message: "oldPhotoUrl 必须指向人物自己的受控照片端点" });
  }
});

export type FaceBox = z.infer<typeof faceBoxSchema>;
export type PhotoMember = z.infer<typeof photoMemberSchema>;
export type LibraryPhoto = z.infer<typeof libraryPhotoSchema>;
export type PersonEntry = z.infer<typeof personSchema>;
export type PeopleLibrary = z.infer<typeof peopleLibrarySchema>;
export type ResolvedPersonEntry = PersonEntry & {
  oldPhotoFile: string;
  photoMimeType: LibraryPhoto["mimeType"];
  photoWidth: number | null;
  photoHeight: number | null;
  faceBox: FaceBox | null;
};

function mimeTypeFromFile(file: string): LibraryPhoto["mimeType"] {
  const extension = extname(file).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function upgradeLegacy(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const legacy = z.array(legacyPersonSchema).parse(input);
  return {
    schemaVersion: 2,
    photos: legacy.map((person) => ({
      id: person.id,
      file: person.oldPhotoFile,
      mimeType: mimeTypeFromFile(person.oldPhotoFile),
      width: null,
      height: null,
      sourceNote: person.sourceNote,
      members: [{ personId: person.id, faceBox: null, azurePersistedFaceId: null }],
    })),
    people: legacy.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      oldPhotoUrl: person.oldPhotoUrl,
      authorization: person.authorization,
      sourceNote: person.sourceNote,
      photoId: person.id,
      azurePersonId: null,
    })),
  };
}

export function parsePeopleLibrary(input: unknown): PeopleLibrary {
  return peopleLibrarySchema.parse(upgradeLegacy(input));
}

export function resolvePeople(library: PeopleLibrary): ResolvedPersonEntry[] {
  const photos = new Map(library.photos.map((photo) => [photo.id, photo]));
  return library.people.map((person) => {
    const photo = photos.get(person.photoId);
    if (!photo) throw new Error(`人物照片不存在：${person.photoId}`);
    const member = photo.members.find((entry) => entry.personId === person.id);
    if (!member) throw new Error(`人物未登记在照片中：${person.id}`);
    return {
      ...person,
      oldPhotoFile: photo.file,
      photoMimeType: photo.mimeType,
      photoWidth: photo.width,
      photoHeight: photo.height,
      faceBox: member.faceBox,
    };
  });
}

export function parsePeople(input: unknown): ResolvedPersonEntry[] {
  return resolvePeople(parsePeopleLibrary(input));
}

const peoplePath = new URL("./people.json", import.meta.url);
/**
 * Committed demo library. Real people.json is untracked (it holds authorized
 * photos and face coordinates), so a fresh clone has none — without this
 * fallback the app cannot start and most tests fail.
 */
const seedPeoplePath = new URL("./seed/people.json", import.meta.url);

export function loadPeopleLibrary(): PeopleLibrary {
  const path = existsSync(peoplePath) ? peoplePath : seedPeoplePath;
  return parsePeopleLibrary(JSON.parse(readFileSync(path, "utf8")));
}

export function loadPeople(): ResolvedPersonEntry[] {
  return resolvePeople(loadPeopleLibrary());
}

export function isPhotoFullyAuthorized(library: PeopleLibrary, photoId: string): boolean {
  const photo = library.photos.find((entry) => entry.id === photoId);
  if (!photo) return false;
  const people = new Map(library.people.map((person) => [person.id, person]));
  return photo.members.every((member) => people.get(member.personId)?.authorization === "authorized");
}
