import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import {
  orientationSwapsAxes,
  readExifOrientation,
  sanitizeJpegMetadata,
} from "./exif.js";
import {
  hasValidImageSignature,
  MAX_PHOTO_BYTES,
} from "./photo-validation.js";
import {
  parsePeopleLibrary,
  resolvePeople,
  type FaceBox,
  type PeopleLibrary,
  type PersonEntry,
  type ResolvedPersonEntry,
} from "./people.js";
import {
  AzureFaceClient,
  type AzureIdentifyResult,
  type DetectedFace,
} from "./providers/azure-face.js";

export interface PeopleAdminPaths {
  peopleFile: string;
  assetsDirectory: string;
}

export interface PeopleAdminOutput {
  write(value: unknown): void;
}

export interface PeopleAdminAzureClient {
  detect(bytes: Buffer, returnFaceId: boolean): Promise<DetectedFace[]>;
  identify(faceIds: string[], maxCandidates?: number): Promise<AzureIdentifyResult[]>;
  ensureGroup(): Promise<void>;
  createPerson(name: string): Promise<string>;
  addFace(personId: string, bytes: Buffer, faceBox: FaceBox): Promise<string>;
  deleteFace(personId: string, persistedFaceId: string): Promise<void>;
  deletePerson(personId: string): Promise<void>;
  train(): Promise<void>;
  waitForTraining(timeoutMs?: number): Promise<void>;
}

export interface PeopleAdminDependencies {
  azureClient?: PeopleAdminAzureClient;
}

const defaultPaths: PeopleAdminPaths = {
  peopleFile: fileURLToPath(new URL("./people.json", import.meta.url)),
  assetsDirectory: fileURLToPath(new URL("./assets/people", import.meta.url)),
};

const extensionMimeTypes = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
} as const;

const usage = `用法：
  npm run people -w @photo-story/server -- list
  npm run people -w @photo-story/server -- get <人物ID>
  npm run people -w @photo-story/server -- add --photo <图片路径> --source-note <来源说明> --member <人物ID>:<展示名>:<faceIndex> [--member ...]
  npm run people -w @photo-story/server -- add --id <人物ID> --display-name <展示名> --photo <图片路径> --source-note <来源说明> [--authorization authorized|placeholder]
  npm run people -w @photo-story/server -- delete <人物ID>
  npm run people -w @photo-story/server -- sync`;

type ParsedOptions = Record<string, string[]>;

export function parseAdminOptions(args: string[], allowed: ReadonlySet<string>): ParsedOptions {
  const options: ParsedOptions = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`参数必须使用 --名称 值 的形式\n${usage}`);
    }
    if (!allowed.has(name)) throw new Error(`未知参数：${name}\n${usage}`);
    (options[name] ??= []).push(value);
  }
  return options;
}

function one(options: ParsedOptions, name: string, required = false): string | undefined {
  const values = options[name] ?? [];
  if (values.length > 1) throw new Error(`参数重复：${name}`);
  if (required && !values[0]) throw new Error(`缺少参数：${name}\n${usage}`);
  return values[0];
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function readLibrary(path: string): Promise<PeopleLibrary> {
  return parsePeopleLibrary(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writeLibrary(path: string, library: PeopleLibrary): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsePeopleLibrary(library), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, path);
  } finally {
    await removeIfExists(temporaryPath);
  }
}

async function withLibraryLock<T>(paths: PeopleAdminPaths, action: () => Promise<T>): Promise<T> {
  const lockPath = `${paths.peopleFile}.lock`;
  let lock: FileHandle;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("人物库正在被另一个管理进程修改，请稍后重试");
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await removeIfExists(lockPath);
  }
}

function intersectionArea(first: FaceBox, second: FaceBox): number {
  const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
  return width * height;
}

function centerInside(container: FaceBox, face: FaceBox): boolean {
  const centerX = face.left + face.width / 2;
  const centerY = face.top + face.height / 2;
  return centerX >= container.left && centerX < container.left + container.width &&
    centerY >= container.top && centerY < container.top + container.height;
}

export function validateFaceBox(
  box: FaceBox,
  image: { width: number; height: number },
  detectedFaces: readonly DetectedFace[],
): number {
  if (
    box.left < 0 || box.top < 0 || box.width <= 0 || box.height <= 0 ||
    box.left + box.width > image.width || box.top + box.height > image.height
  ) {
    throw new Error("人脸框超出照片边界");
  }
  const centered = detectedFaces
    .map((face, index) => ({ face, index }))
    .filter(({ face }) => centerInside(box, face.faceRectangle));
  if (centered.length !== 1) throw new Error("人脸框内必须恰好包含一张已检测人脸的中心点");
  const selected = centered[0]!;
  const selectedCoverage = intersectionArea(box, selected.face.faceRectangle) /
    (selected.face.faceRectangle.width * selected.face.faceRectangle.height);
  if (selectedCoverage < 0.8) throw new Error("人脸框与所选人脸重叠不足");
  const overlapsAnotherFace = detectedFaces.some((face, index) =>
    index !== selected.index &&
    intersectionArea(box, face.faceRectangle) / (face.faceRectangle.width * face.faceRectangle.height) >= 0.2
  );
  if (overlapsAnotherFace) throw new Error("人脸框跨越了其他人脸");
  return selected.index;
}

/**
 * Enrollment quality floor. Azure recommends "high" for enrollment, but
 * "medium" faces still identify reliably enough for this library's group
 * photos; "low" is always rejected. Confirmed for SVHWB-6.
 */
const acceptableEnrollmentQuality = new Set(["high", "medium"]);

function assertEnrollmentQuality(
  quality: string | undefined,
  label: string,
): void {
  if (!quality || !acceptableEnrollmentQuality.has(quality)) {
    throw new Error(`${label} 的识别质量为 ${quality ?? "未知"}，入库要求 high 或 medium`);
  }
}

interface MemberInput {
  id: string;
  displayName: string;
  faceIndex: number;
}

function parseMember(value: string): MemberInput {
  const parts = value.split(":");
  const id = parts.shift();
  const faceIndexText = parts.pop();
  const displayName = parts.join(":");
  const faceIndex = Number(faceIndexText);
  if (!id || !displayName || !Number.isSafeInteger(faceIndex) || faceIndex < 0) {
    throw new Error(`--member 必须为 <人物ID>:<展示名>:<faceIndex>：${value}`);
  }
  return { id, displayName, faceIndex };
}

/**
 * Dimensions of the image as stored, ignoring Exif orientation.
 *
 * Callers that compare against Azure face rectangles want getDimensions()
 * instead — Azure reports coordinates in the Exif-normalized frame.
 */
function getStoredDimensions(
  bytes: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (mimeType === "image/jpeg") {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1]!;
      if (startOfFrameMarkers.has(marker)) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (offset + 4 > bytes.length) return undefined;
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2) return undefined;
      offset += 2 + segmentLength;
    }
  }
  if (
    mimeType === "image/webp" &&
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  return undefined;
}

/**
 * Dimensions in the same frame Azure Face reports face rectangles in.
 *
 * Azure normalizes Exif orientation before detection, so a portrait photo
 * stored as landscape (orientation 5-8) yields rectangles against the swapped
 * frame. Validating those against the stored width/height rejects legitimate
 * faces near the rotated edges, so the axes are swapped to match.
 */
export function getDimensions(
  bytes: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
): { width: number; height: number } | undefined {
  const stored = getStoredDimensions(bytes, mimeType);
  if (!stored) return undefined;
  if (mimeType !== "image/jpeg") return stored;
  if (!orientationSwapsAxes(readExifOrientation(bytes))) return stored;
  return { width: stored.height, height: stored.width };
}

async function rollbackCreated(client: PeopleAdminAzureClient, personIds: string[]): Promise<void> {
  for (const personId of [...personIds].reverse()) {
    try {
      await client.deletePerson(personId);
    } catch {
      // Continue deleting the remaining newly-created records.
    }
  }
  if (personIds.length > 0) {
    try {
      await client.train();
      await client.waitForTraining();
    } catch {
      // The original enrollment error remains primary; maintenance docs cover reconciliation.
    }
  }
}

async function train(client: PeopleAdminAzureClient): Promise<void> {
  await client.train();
  await client.waitForTraining();
}

async function verifyEnrollment(
  client: PeopleAdminAzureClient,
  photo: Buffer,
  image: { width: number; height: number },
  expectedByBox: Array<{ box: FaceBox; azurePersonId: string }>,
): Promise<void> {
  const detected = await client.detect(photo, true);
  const expectedByFaceId = new Map<string, string>();
  for (const expected of expectedByBox) {
    const index = validateFaceBox(expected.box, image, detected);
    const faceId = detected[index]?.faceId;
    if (!faceId) throw new Error("入库自检未返回 faceId");
    expectedByFaceId.set(faceId, expected.azurePersonId);
  }
  const faceIds = [...expectedByFaceId.keys()];
  for (let start = 0; start < faceIds.length; start += 10) {
    const batch = faceIds.slice(start, start + 10);
    const results = await client.identify(batch, 5);
    if (results.length !== batch.length) throw new Error("入库后自检失败：Identify 返回数量不完整");
    const returned = new Set<string>();
    for (const result of results) {
      returned.add(result.faceId);
      const expected = expectedByFaceId.get(result.faceId);
      if (!expected || result.candidates[0]?.personId !== expected) {
        throw new Error("入库后自检失败：Top-1 人物与登记成员不一致");
      }
    }
    if (batch.some((faceId) => !returned.has(faceId))) {
      throw new Error("入库后自检失败：Identify 缺少已检测人脸");
    }
  }
}

function defaultAzureClient(): PeopleAdminAzureClient | undefined {
  if (process.env.PROVIDER_MODE !== "real") return undefined;
  const config = readConfig();
  if (!config.azureFace) throw new Error("real 模式缺少 Azure Face 配置");
  return new AzureFaceClient(config.azureFace);
}

async function addPeople(
  args: string[],
  paths: PeopleAdminPaths,
  client: PeopleAdminAzureClient | undefined,
): Promise<{ action: "added"; people: ResolvedPersonEntry[]; detectedFaces?: DetectedFace[] }> {
  const options = parseAdminOptions(args, new Set([
    "--id", "--display-name", "--photo", "--source-note", "--authorization", "--member",
  ]));
  const inputPhoto = resolve(one(options, "--photo", true)!);
  const sourceNote = one(options, "--source-note", true)!;
  const authorization = one(options, "--authorization") ?? "authorized";
  if (authorization !== "authorized" && authorization !== "placeholder") {
    throw new Error("--authorization 只能是 authorized 或 placeholder");
  }
  const memberValues = options["--member"] ?? [];
  const legacyId = one(options, "--id");
  const legacyName = one(options, "--display-name");
  if (memberValues.length > 0 && (legacyId || legacyName)) {
    throw new Error("--member 不能与 --id/--display-name 混用");
  }
  if (memberValues.length === 0 && (!legacyId || !legacyName)) {
    throw new Error("必须提供至少一个 --member，或同时提供 --id 与 --display-name");
  }
  const extension = extname(inputPhoto).toLowerCase();
  const mimeType = extensionMimeTypes[extension as keyof typeof extensionMimeTypes];
  if (!mimeType) throw new Error("照片只支持 JPEG、PNG 或 WebP");
  const original = await readFile(inputPhoto);
  // Library photos are served to end users, so capture metadata (GPS, time,
  // device) must not be stored. Orientation is preserved; see sanitizeJpegMetadata.
  const bytes = mimeType === "image/jpeg" ? sanitizeJpegMetadata(original) : original;
  if (bytes !== original) original.fill(0);
  try {
    if (bytes.length > MAX_PHOTO_BYTES) throw new Error("照片不能超过 6 MiB");
    if (!hasValidImageSignature(bytes, mimeType)) throw new Error("照片内容与扩展名不匹配，或图片格式无效");
    const dimensions = getDimensions(bytes, mimeType);
    let detectedFaces: DetectedFace[] | undefined;
    let members: MemberInput[];
    if (memberValues.length > 0) {
      if (!client) throw new Error("多人物登记需要 PROVIDER_MODE=real 的 Azure Face 配置");
      if (!dimensions) throw new Error("无法读取照片宽高");
      detectedFaces = await client.detect(bytes, false);
      members = memberValues.map(parseMember);
      if (new Set(members.map((member) => member.id)).size !== members.length) throw new Error("同一人物不能重复登记");
      if (new Set(members.map((member) => member.faceIndex)).size !== members.length) throw new Error("同一张脸不能登记给多个人物");
      if (members.length !== detectedFaces.length) throw new Error("合影中的每张人脸都必须登记为已授权成员");
      for (const member of members) {
        const face = detectedFaces[member.faceIndex];
        if (!face) throw new Error(`faceIndex 越界：${member.faceIndex}`);
        assertEnrollmentQuality(face.qualityForRecognition, `faceIndex ${member.faceIndex}`);
        validateFaceBox(face.faceRectangle, dimensions, detectedFaces);
      }
      if (authorization !== "authorized") throw new Error("real 模式合影必须取得全员 authorized 授权");
    } else {
      members = [{ id: legacyId!, displayName: legacyName!, faceIndex: 0 }];
    }

    return await withLibraryLock(paths, async () => {
      const library = await readLibrary(paths.peopleFile);
      for (const member of members) {
        if (library.people.some((person) => person.id === member.id)) throw new Error(`人物已存在：${member.id}`);
      }
      const photoId = `photo-${randomUUID()}`.slice(0, 64);
      const storedExtension = mimeType === "image/jpeg" ? ".jpg" : extension;
      const file = `${randomUUID()}${storedExtension}`;
      const createdAzureIds: string[] = [];
      const azureEntries = new Map<string, { personId: string; persistedFaceId: string }>();
      if (client && detectedFaces) {
        try {
          await client.ensureGroup();
          for (const member of members) {
            const personId = await client.createPerson(member.id);
            createdAzureIds.push(personId);
            const faceBox = detectedFaces[member.faceIndex]!.faceRectangle;
            const persistedFaceId = await client.addFace(personId, bytes, faceBox);
            azureEntries.set(member.id, { personId, persistedFaceId });
          }
          await train(client);
          await verifyEnrollment(client, bytes, dimensions!, members.map((member) => ({
            box: detectedFaces![member.faceIndex]!.faceRectangle,
            azurePersonId: azureEntries.get(member.id)!.personId,
          })));
        } catch (error) {
          await rollbackCreated(client, createdAzureIds);
          throw error;
        }
      }

      const people: PersonEntry[] = members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        photoId,
        oldPhotoUrl: `/api/people/${member.id}/photo`,
        authorization,
        sourceNote,
        azurePersonId: azureEntries.get(member.id)?.personId ?? null,
      }));
      const next = parsePeopleLibrary({
        ...library,
        photos: [...library.photos, {
          id: photoId,
          file,
          mimeType,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          sourceNote,
          members: members.map((member) => ({
            personId: member.id,
            faceBox: detectedFaces?.[member.faceIndex]?.faceRectangle ?? null,
            azurePersistedFaceId: azureEntries.get(member.id)?.persistedFaceId ?? null,
          })),
        }],
        people: [...library.people, ...people],
      });
      const destination = resolve(paths.assetsDirectory, file);
      await mkdir(paths.assetsDirectory, { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      try {
        await writeLibrary(paths.peopleFile, next);
      } catch (error) {
        await removeIfExists(destination);
        if (client) await rollbackCreated(client, createdAzureIds);
        throw error;
      }
      const resolved = resolvePeople(next).filter((person) => members.some((member) => member.id === person.id));
      return { action: "added", people: resolved, ...(detectedFaces ? { detectedFaces } : {}) };
    });
  } finally {
    bytes.fill(0);
  }
}

async function deletePerson(
  id: string,
  paths: PeopleAdminPaths,
  client: PeopleAdminAzureClient | undefined,
): Promise<{ action: "deleted"; person: ResolvedPersonEntry; photoDeleted: boolean }> {
  return withLibraryLock(paths, async () => {
    const library = await readLibrary(paths.peopleFile);
    const person = resolvePeople(library).find((entry) => entry.id === id);
    if (!person) throw new Error(`人物不存在：${id}`);
    const photo = library.photos.find((entry) => entry.id === person.photoId)!;
    const member = photo.members.find((entry) => entry.personId === id)!;
    if (person.azurePersonId || member.azurePersistedFaceId) {
      if (!client) throw new Error("删除 Azure 人脸模板需要 PROVIDER_MODE=real 的 Azure Face 配置");
      if (person.azurePersonId && member.azurePersistedFaceId) {
        await client.deleteFace(person.azurePersonId, member.azurePersistedFaceId);
      }
      if (person.azurePersonId) await client.deletePerson(person.azurePersonId);
      try {
        await train(client);
      } catch {
        throw new Error("Azure 侧删除已提交，但重训失败，删除尚未对 Identify 生效；请运行 sync 修复");
      }
    }
    const remainingMembers = photo.members.filter((entry) => entry.personId !== id);
    const photoDeleted = remainingMembers.length === 0;
    const next = parsePeopleLibrary({
      ...library,
      people: library.people.filter((entry) => entry.id !== id),
      photos: photoDeleted
        ? library.photos.filter((entry) => entry.id !== photo.id)
        : library.photos.map((entry) => entry.id === photo.id ? { ...entry, members: remainingMembers } : entry),
    });
    await writeLibrary(paths.peopleFile, next);
    if (photoDeleted) await removeIfExists(resolve(paths.assetsDirectory, photo.file));
    return { action: "deleted", person, photoDeleted };
  });
}

async function syncLibrary(
  paths: PeopleAdminPaths,
  client: PeopleAdminAzureClient | undefined,
): Promise<{ action: "synced"; people: number; photos: number }> {
  if (!client) throw new Error("sync 需要 PROVIDER_MODE=real 的 Azure Face 配置");
  return withLibraryLock(paths, async () => {
    const library = await readLibrary(paths.peopleFile);
    if (library.people.some((person) => person.authorization !== "authorized")) {
      throw new Error("real 模式 sync 要求所有照片成员均已授权；placeholder 不能入库");
    }
    await client.ensureGroup();
    const createdIds: string[] = [];
    const replacements = new Map<string, { personId: string; persistedFaceId: string }>();
    let oldDeletionStarted = false;
    try {
      for (const photo of library.photos) {
        if (!photo.members.every((member) => library.people.find((person) => person.id === member.personId)?.authorization === "authorized")) {
          throw new Error(`合影 ${photo.id} 未取得全员授权`);
        }
        const bytes = await readFile(resolve(paths.assetsDirectory, photo.file));
        try {
          const dimensions = getDimensions(bytes, photo.mimeType as "image/jpeg" | "image/png" | "image/webp");
          if (!dimensions) throw new Error(`无法读取照片宽高：${photo.id}`);
          const faces = await client.detect(bytes, false);
          for (const member of photo.members) {
            if (!member.faceBox) throw new Error(`sync 要求 faceBox：${photo.id}/${member.personId}`);
            const faceIndex = validateFaceBox(member.faceBox, dimensions, faces);
            assertEnrollmentQuality(
              faces[faceIndex]?.qualityForRecognition,
              `${photo.id}/${member.personId}`,
            );
            const personId = await client.createPerson(member.personId);
            createdIds.push(personId);
            const persistedFaceId = await client.addFace(personId, bytes, member.faceBox);
            replacements.set(member.personId, { personId, persistedFaceId });
          }
        } finally {
          bytes.fill(0);
        }
      }
      await train(client);

      oldDeletionStarted = true;
      for (const person of library.people) {
        if (person.azurePersonId) await client.deletePerson(person.azurePersonId);
      }
      await train(client);
      for (const photo of library.photos) {
        const bytes = await readFile(resolve(paths.assetsDirectory, photo.file));
        try {
          await verifyEnrollment(client, bytes, {
            width: photo.width!,
            height: photo.height!,
          }, photo.members.map((member) => {
            if (!member.faceBox) throw new Error(`sync 要求 faceBox：${photo.id}/${member.personId}`);
            return {
              box: member.faceBox,
              azurePersonId: replacements.get(member.personId)!.personId,
            };
          }));
        } finally {
          bytes.fill(0);
        }
      }

      const next = parsePeopleLibrary({
        ...library,
        people: library.people.map((person) => ({
          ...person,
          azurePersonId: replacements.get(person.id)!.personId,
        })),
        photos: library.photos.map((photo) => ({
          ...photo,
          members: photo.members.map((member) => ({
            ...member,
            azurePersistedFaceId: replacements.get(member.personId)!.persistedFaceId,
          })),
        })),
      });
      await writeLibrary(paths.peopleFile, next);
      return { action: "synced", people: next.people.length, photos: next.photos.length };
    } catch (error) {
      if (!oldDeletionStarted) {
        await rollbackCreated(client, createdIds);
      }
      throw error;
    }
  });
}

function requireSingleId(args: string[]): string {
  if (args.length !== 1 || !args[0]) throw new Error(usage);
  return args[0];
}

export async function runPeopleAdmin(
  args: string[],
  paths: PeopleAdminPaths = defaultPaths,
  output: PeopleAdminOutput = { write: (value) => console.log(JSON.stringify(value, null, 2)) },
  dependencies: PeopleAdminDependencies = {},
): Promise<void> {
  const [command, ...commandArgs] = args;
  const client = dependencies.azureClient ?? defaultAzureClient();
  if (command === "list") {
    if (commandArgs.length > 0) throw new Error(usage);
    output.write(await readLibrary(paths.peopleFile));
    return;
  }
  if (command === "get") {
    const id = requireSingleId(commandArgs);
    const person = resolvePeople(await readLibrary(paths.peopleFile)).find((entry) => entry.id === id);
    if (!person) throw new Error(`人物不存在：${id}`);
    output.write(person);
    return;
  }
  if (command === "add") {
    output.write(await addPeople(commandArgs, paths, client));
    return;
  }
  if (command === "delete") {
    output.write(await deletePerson(requireSingleId(commandArgs), paths, client));
    return;
  }
  if (command === "sync") {
    if (commandArgs.length > 0) throw new Error(usage);
    output.write(await syncLibrary(paths, client));
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    output.write(usage);
    return;
  }
  throw new Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPeopleAdmin(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
