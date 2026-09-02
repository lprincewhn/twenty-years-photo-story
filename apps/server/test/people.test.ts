import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPhotoFullyAuthorized, parsePeople, parsePeopleLibrary } from "../src/people.js";

function library() {
  return {
    schemaVersion: 2,
    photos: [{
      id: "group-photo",
      file: "group.jpg",
      mimeType: "image/jpeg",
      width: 200,
      height: 100,
      sourceNote: "全员授权合影",
      members: [
        { personId: "person-a", faceBox: { left: 10, top: 10, width: 30, height: 30 }, azurePersistedFaceId: null },
        { personId: "person-b", faceBox: { left: 100, top: 10, width: 30, height: 30 }, azurePersistedFaceId: null },
      ],
    }],
    people: [
      { id: "person-a", displayName: "甲", photoId: "group-photo", oldPhotoUrl: "/api/people/person-a/photo", authorization: "authorized", sourceNote: "授权", azurePersonId: null },
      { id: "person-b", displayName: "乙", photoId: "group-photo", oldPhotoUrl: "/api/people/person-b/photo", authorization: "authorized", sourceNote: "授权", azurePersonId: null },
    ],
  } as const;
}

describe("人物库 v2 schema", () => {
  it("允许一张照片登记多个人物，并执行全员授权判断", () => {
    const parsed = parsePeopleLibrary(library());
    expect(parsed.people).toHaveLength(2);
    expect(isPhotoFullyAuthorized(parsed, "group-photo")).toBe(true);
    const withdrawn = parsePeopleLibrary({
      ...library(),
      people: library().people.map((person, index) =>
        index === 0 ? { ...person, authorization: "placeholder" } : person),
    });
    expect(isPhotoFullyAuthorized(withdrawn, "group-photo")).toBe(false);
  });

  it.each([
    ["悬空 photoId", (value: ReturnType<typeof library>) => ({ ...value, people: [{ ...value.people[0], photoId: "missing" }, value.people[1]] })],
    ["悬空 personId", (value: ReturnType<typeof library>) => ({ ...value, photos: [{ ...value.photos[0], members: [{ ...value.photos[0].members[0], personId: "missing" }, value.photos[0].members[1]] }] })],
    ["重复成员", (value: ReturnType<typeof library>) => ({ ...value, photos: [{ ...value.photos[0], members: [value.photos[0].members[0], value.photos[0].members[0], value.photos[0].members[1]] }] })],
    ["越界 faceBox", (value: ReturnType<typeof library>) => ({ ...value, photos: [{ ...value.photos[0], members: [{ ...value.photos[0].members[0], faceBox: { left: 190, top: 10, width: 30, height: 30 } }, value.photos[0].members[1]] }] })],
    ["双向不一致", (value: ReturnType<typeof library>) => ({ ...value, photos: [{ ...value.photos[0], members: [value.photos[0].members[0]] }] })],
  ])("拒绝%s", (_name, mutate) => {
    expect(() => parsePeopleLibrary(mutate(library()))).toThrow();
  });

  it("把旧数组透明升级为可解析的 v2 运行时人物", () => {
    const people = parsePeople([{
      id: "legacy",
      displayName: "旧人物",
      oldPhotoUrl: "/api/people/legacy/photo",
      oldPhotoFile: "legacy.webp",
      authorization: "authorized",
      sourceNote: "历史授权",
    }]);
    expect(people[0]).toMatchObject({
      id: "legacy",
      photoId: "legacy",
      oldPhotoFile: "legacy.webp",
      azurePersonId: null,
    });
  });

  it("内置 seed 人物库可解析，且其照片文件随仓库提交", () => {
    // people.json and assets/people/ are untracked (they hold authorized photos
    // and face coordinates), so a fresh clone only has the seed. If the seed is
    // missing or unparseable, the app cannot start and most tests fail.
    const seedUrl = new URL("../src/seed/people.json", import.meta.url);
    const library = parsePeopleLibrary(JSON.parse(readFileSync(seedUrl, "utf8")));
    expect(library.people.length).toBeGreaterThan(0);
    for (const photo of library.photos) {
      expect(existsSync(new URL(`../src/seed/assets/people/${photo.file}`, import.meta.url)))
        .toBe(true);
    }
    // The seed must stay a placeholder: no real faces belong in a public repo.
    expect(library.people.every((person) => person.authorization === "placeholder")).toBe(true);
  });
});
