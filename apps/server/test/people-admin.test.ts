import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasExifGpsData, readExifOrientation } from "../src/exif.js";
import {
  runPeopleAdmin,
  validateFaceBox,
  type PeopleAdminAzureClient,
  type PeopleAdminPaths,
} from "../src/people-admin.js";
import { parsePeopleLibrary } from "../src/people.js";

const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/**
 * JPEG carrying an Exif orientation tag, a GPS IFD pointer, and an SOF0 frame
 * declaring the stored (unrotated) dimensions — the shape a phone photo has.
 */
function jpegWithOrientation(
  storedWidth: number,
  storedHeight: number,
  orientation: number,
): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 24 + 4);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt16BE(0x8825, 22); // GPS IFD pointer
  tiff.writeUInt16BE(4, 24);
  tiff.writeUInt32BE(1, 26);
  tiff.writeUInt32BE(0, 30);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);

  // Marker (2) + declared length (17 = 2 length bytes + 15 payload for 3 components).
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(storedHeight, 5);
  sof0.writeUInt16BE(storedWidth, 7);
  sof0[9] = 3;
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app1, payload, sof0, sos, Buffer.from([0xff, 0xd9]),
  ]);
}

describe("人物库管理脚本", () => {
  let root: string;
  let paths: PeopleAdminPaths;
  let outputs: unknown[];

  beforeEach(async () => {
    root = join(process.cwd(), `.people-admin-test-${randomUUID()}`);
    paths = { peopleFile: join(root, "people.json"), assetsDirectory: join(root, "assets") };
    outputs = [];
    await mkdir(paths.assetsDirectory, { recursive: true });
    await writeFile(paths.peopleFile, "[]\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("兼容单人物参数并写入 v2 schema", async () => {
    const inputPhoto = join(root, "input.jpg");
    await writeFile(inputPhoto, validJpeg);
    const output = { write: (value: unknown) => outputs.push(value) };
    await runPeopleAdmin([
      "add", "--id", "person-one", "--display-name", "人物一", "--photo", inputPhoto,
      "--source-note", "已完成用途授权。",
    ], paths, output);

    const added = outputs[0] as { action: string; people: Array<{ oldPhotoFile: string }> };
    expect(added.action).toBe("added");
    expect(added.people[0]).toMatchObject({
      id: "person-one", displayName: "人物一", authorization: "authorized",
      oldPhotoUrl: "/api/people/person-one/photo",
    });
    const file = added.people[0]!.oldPhotoFile;
    expect(await readFile(join(paths.assetsDirectory, file))).toEqual(validJpeg);
    expect(JSON.parse(await readFile(paths.peopleFile, "utf8"))).toMatchObject({ schemaVersion: 2 });

    outputs = [];
    await runPeopleAdmin(["delete", "person-one"], paths, output);
    expect(outputs[0]).toMatchObject({ action: "deleted", photoDeleted: true });
    expect(parsePeopleLibrary(JSON.parse(await readFile(paths.peopleFile, "utf8"))).people).toEqual([]);
    await expect(readFile(join(paths.assetsDirectory, file))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("累积多个 --member，按 faceIndex 入库并执行训练和自检", async () => {
    const inputPhoto = join(root, "group.png");
    await writeFile(inputPhoto, pngHeader(200, 100));
    const faces = [
      { faceId: "11111111-1111-4111-8111-111111111111", faceRectangle: { left: 10, top: 10, width: 40, height: 40 }, qualityForRecognition: "high" as const },
      { faceId: "22222222-2222-4222-8222-222222222222", faceRectangle: { left: 120, top: 10, width: 40, height: 40 }, qualityForRecognition: "high" as const },
    ];
    const personIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    let personIndex = 0;
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(async (_bytes, returnFaceId) => faces.map((face) => returnFaceId ? face : { ...face, faceId: undefined })),
      identify: vi.fn(async (faceIds: string[]) => faceIds.map((faceId: string, index: number) => ({
        faceId, candidates: [{ personId: personIds[index]!, confidence: 1 }],
      }))),
      ensureGroup: vi.fn(async () => undefined),
      createPerson: vi.fn(async () => personIds[personIndex++]!),
      addFace: vi.fn(async (_id, _bytes, box) => box.left < 100
        ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        : "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      deleteFace: vi.fn(async () => undefined),
      deletePerson: vi.fn(async () => undefined),
      train: vi.fn(async () => undefined),
      waitForTraining: vi.fn(async () => undefined),
    };
    await runPeopleAdmin([
      "add", "--photo", inputPhoto, "--source-note", "全员已授权",
      "--member", "person-a:人物甲:0", "--member", "person-b:人物乙:1",
    ], paths, { write: (value) => outputs.push(value) }, { azureClient: client });

    const library = parsePeopleLibrary(JSON.parse(await readFile(paths.peopleFile, "utf8")));
    expect(library.people).toHaveLength(2);
    expect(library.photos[0]?.members.map((member) => member.personId)).toEqual(["person-a", "person-b"]);
    expect(client.createPerson).toHaveBeenCalledTimes(2);
    expect(client.identify).toHaveBeenCalledTimes(1);
  });

  it("竖拍照片（orientation=6）按 Azure 旋转后的坐标系校验人脸框", async () => {
    // Regression for SVHWB-6: the photo is stored 4618x3464 but Exif
    // orientation 6 means Azure reports rectangles against 3464x4618. Validating
    // against the stored frame rejected the face at top=3297 (bottom 3708 >
    // 3464) even though it is legitimate. Coordinates are from the real photo.
    const inputPhoto = join(root, "portrait.jpg");
    await writeFile(inputPhoto, jpegWithOrientation(4618, 3464, 6));
    const faces = [
      { faceId: "11111111-1111-4111-8111-111111111111", faceRectangle: { left: 1614, top: 3297, width: 325, height: 411 }, qualityForRecognition: "high" as const },
      { faceId: "22222222-2222-4222-8222-222222222222", faceRectangle: { left: 1733, top: 2066, width: 294, height: 369 }, qualityForRecognition: "high" as const },
      { faceId: "33333333-3333-4333-8333-333333333333", faceRectangle: { left: 1761, top: 2905, width: 272, height: 336 }, qualityForRecognition: "medium" as const },
    ];
    const personIds = faces.map((_face, index) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index}`);
    let created = 0;
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(async (_bytes, returnFaceId) =>
        faces.map((face) => returnFaceId ? face : { ...face, faceId: undefined })),
      identify: vi.fn(async (faceIds: string[]) => faceIds.map((faceId: string) => ({
        faceId,
        candidates: [{ personId: personIds[faces.findIndex((face) => face.faceId === faceId)]!, confidence: 1 }],
      }))),
      ensureGroup: vi.fn(async () => undefined),
      createPerson: vi.fn(async () => personIds[created++]!),
      addFace: vi.fn(async () => randomUUID()),
      deleteFace: vi.fn(async () => undefined),
      deletePerson: vi.fn(async () => undefined),
      train: vi.fn(async () => undefined),
      waitForTraining: vi.fn(async () => undefined),
    };

    await runPeopleAdmin([
      "add", "--photo", inputPhoto, "--source-note", "全员已授权",
      "--member", "adult:成年人:0", "--member", "child-one:儿童一:1", "--member", "child-two:儿童二:2",
    ], paths, { write: (value) => outputs.push(value) }, { azureClient: client });

    const library = parsePeopleLibrary(JSON.parse(await readFile(paths.peopleFile, "utf8")));
    expect(library.people).toHaveLength(3);
    // Stored dimensions follow Azure's frame, so faceBox values stay comparable.
    expect(library.photos[0]).toMatchObject({ width: 3464, height: 4618 });
    // A medium-quality face is accepted; only "low" is refused.
    expect(library.photos[0]?.members.map((member) => member.personId))
      .toEqual(["adult", "child-one", "child-two"]);
  });

  it("入库时剥离 GPS 等元数据，但保留 orientation", async () => {
    const inputPhoto = join(root, "geotagged.jpg");
    const original = jpegWithOrientation(4618, 3464, 6);
    await writeFile(inputPhoto, original);
    expect(hasExifGpsData(original)).toBe(true);

    await runPeopleAdmin([
      "add", "--id", "person-geo", "--display-name", "带定位", "--photo", inputPhoto,
      "--source-note", "已完成用途授权。",
    ], paths, { write: (value) => outputs.push(value) });

    const added = outputs[0] as { people: Array<{ oldPhotoFile: string }> };
    const stored = await readFile(join(paths.assetsDirectory, added.people[0]!.oldPhotoFile));
    // Library photos are served to end users; capture location must not ship.
    expect(hasExifGpsData(stored)).toBe(false);
    expect(readExifOrientation(stored)).toBe(6);
    expect(stored.length).toBeLessThan(original.length);
  });

  it("拒绝 low 质量人脸入库", async () => {
    const inputPhoto = join(root, "lowquality.jpg");
    await writeFile(inputPhoto, jpegWithOrientation(200, 100, 1));
    const faces = [{
      faceId: "44444444-4444-4444-8444-444444444444",
      faceRectangle: { left: 10, top: 10, width: 40, height: 40 },
      qualityForRecognition: "low" as const,
    }];
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(async () => faces),
      identify: vi.fn(), ensureGroup: vi.fn(), createPerson: vi.fn(), addFace: vi.fn(),
      deleteFace: vi.fn(), deletePerson: vi.fn(), train: vi.fn(), waitForTraining: vi.fn(),
    };
    await expect(runPeopleAdmin([
      "add", "--photo", inputPhoto, "--source-note", "全员已授权", "--member", "person-low:低质量:0",
    ], paths, { write: (value) => outputs.push(value) }, { azureClient: client }))
      .rejects.toThrow("high 或 medium");
    expect(client.createPerson).not.toHaveBeenCalled();
  });

  it("几何校验拒绝零脸、跨脸和越界 faceIndex", () => {
    const faces = [
      { faceRectangle: { left: 10, top: 10, width: 40, height: 40 } },
      { faceRectangle: { left: 60, top: 10, width: 40, height: 40 } },
    ];
    expect(validateFaceBox(faces[0]!.faceRectangle, { width: 120, height: 80 }, faces)).toBe(0);
    expect(() => validateFaceBox({ left: 0, top: 60, width: 20, height: 20 }, { width: 120, height: 80 }, faces))
      .toThrow("恰好包含一张");
    expect(() => validateFaceBox({ left: 5, top: 5, width: 90, height: 50 }, { width: 120, height: 80 }, faces))
      .toThrow();
  });

  it("删除共享照片中的一个成员时保留照片", async () => {
    const photo = join(paths.assetsDirectory, "shared.jpg");
    await writeFile(photo, validJpeg);
    await writeFile(paths.peopleFile, JSON.stringify({
      schemaVersion: 2,
      photos: [{
        id: "shared", file: "shared.jpg", mimeType: "image/jpeg", width: null, height: null,
        sourceNote: "授权", members: [
          { personId: "a", faceBox: null, azurePersistedFaceId: null },
          { personId: "b", faceBox: null, azurePersistedFaceId: null },
        ],
      }],
      people: [
        { id: "a", displayName: "甲", photoId: "shared", oldPhotoUrl: "/api/people/a/photo", authorization: "authorized", sourceNote: "授权", azurePersonId: null },
        { id: "b", displayName: "乙", photoId: "shared", oldPhotoUrl: "/api/people/b/photo", authorization: "authorized", sourceNote: "授权", azurePersonId: null },
      ],
    }));
    await runPeopleAdmin(["delete", "a"], paths, { write: (value) => outputs.push(value) });
    expect(outputs[0]).toMatchObject({ photoDeleted: false });
    expect(await readFile(photo)).toEqual(validJpeg);
  });

  it("入库后自检按 10 张脸分批", async () => {
    const inputPhoto = join(root, "eleven.png");
    await writeFile(inputPhoto, pngHeader(240, 30));
    const faces = Array.from({ length: 11 }, (_, index) => ({
      faceId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      faceRectangle: { left: index * 20, top: 5, width: 10, height: 10 },
      qualityForRecognition: "high" as const,
    }));
    const personIds = faces.map((_face, index) =>
      `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    let created = 0;
    const identifyBatchSizes: number[] = [];
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(async () => faces),
      identify: vi.fn(async (faceIds: string[]) => {
        identifyBatchSizes.push(faceIds.length);
        return faceIds.map((id) => {
          const index = faces.findIndex((face) => face.faceId === id);
          return { faceId: id, candidates: [{ personId: personIds[index]!, confidence: 1 }] };
        });
      }),
      ensureGroup: vi.fn(async () => undefined),
      createPerson: vi.fn(async () => personIds[created++]!),
      addFace: vi.fn(async (_id, _bytes, box) =>
        `30000000-0000-4000-8000-${String(box.left / 20).padStart(12, "0")}`),
      deleteFace: vi.fn(async () => undefined),
      deletePerson: vi.fn(async () => undefined),
      train: vi.fn(async () => undefined),
      waitForTraining: vi.fn(async () => undefined),
    };
    const args = [
      "add", "--photo", inputPhoto, "--source-note", "全员授权",
      ...faces.flatMap((_face, index) => ["--member", `p-${index}:人物${index}:${index}`]),
    ];
    await runPeopleAdmin(args, paths, { write: () => undefined }, { azureClient: client });
    expect(identifyBatchSizes).toEqual([10, 1]);
  });

  it("自检失败时回滚本轮 Azure person 且不写本地", async () => {
    const inputPhoto = join(root, "one.png");
    await writeFile(inputPhoto, pngHeader(100, 100));
    const personId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const deletePerson = vi.fn(async () => undefined);
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(async () => [{
        faceId: "11111111-1111-4111-8111-111111111111",
        faceRectangle: { left: 10, top: 10, width: 40, height: 40 },
        qualityForRecognition: "high" as const,
      }]),
      identify: vi.fn(async (faceIds: string[]) => faceIds.map((id) => ({
        faceId: id,
        candidates: [{ personId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", confidence: 1 }],
      }))),
      ensureGroup: vi.fn(async () => undefined),
      createPerson: vi.fn(async () => personId),
      addFace: vi.fn(async () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      deleteFace: vi.fn(async () => undefined),
      deletePerson,
      train: vi.fn(async () => undefined),
      waitForTraining: vi.fn(async () => undefined),
    };
    await expect(runPeopleAdmin([
      "add", "--photo", inputPhoto, "--source-note", "授权", "--member", "person:人物:0",
    ], paths, { write: () => undefined }, { azureClient: client })).rejects.toThrow("Top-1");
    expect(deletePerson).toHaveBeenCalledWith(personId);
    expect(parsePeopleLibrary(JSON.parse(await readFile(paths.peopleFile, "utf8"))).people).toEqual([]);
  });

  it("删除后重训失败时命令失败且不声称本地删除完成", async () => {
    await writeFile(join(paths.assetsDirectory, "person.jpg"), validJpeg);
    const original = {
      schemaVersion: 2,
      photos: [{
        id: "photo", file: "person.jpg", mimeType: "image/jpeg", width: null, height: null,
        sourceNote: "授权", members: [{
          personId: "person", faceBox: null,
          azurePersistedFaceId: "11111111-1111-4111-8111-111111111111",
        }],
      }],
      people: [{
        id: "person", displayName: "人物", photoId: "photo",
        oldPhotoUrl: "/api/people/person/photo", authorization: "authorized",
        sourceNote: "授权", azurePersonId: "22222222-2222-4222-8222-222222222222",
      }],
    };
    await writeFile(paths.peopleFile, JSON.stringify(original));
    const client: PeopleAdminAzureClient = {
      detect: vi.fn(), identify: vi.fn(), ensureGroup: vi.fn(), createPerson: vi.fn(), addFace: vi.fn(),
      deleteFace: vi.fn(async () => undefined),
      deletePerson: vi.fn(async () => undefined),
      train: vi.fn(async () => { throw new Error("training failed"); }),
      waitForTraining: vi.fn(async () => undefined),
    };
    await expect(runPeopleAdmin(
      ["delete", "person"], paths, { write: () => undefined }, { azureClient: client },
    )).rejects.toThrow("删除尚未对 Identify 生效");
    expect(JSON.parse(await readFile(paths.peopleFile, "utf8"))).toEqual(original);
  });
});
