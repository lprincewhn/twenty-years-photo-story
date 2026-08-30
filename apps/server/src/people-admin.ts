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
import {
  hasValidImageSignature,
  MAX_PHOTO_BYTES,
} from "./photo-validation.js";
import { parsePeople, type PersonEntry } from "./people.js";

export interface PeopleAdminPaths {
  peopleFile: string;
  assetsDirectory: string;
}

export interface PeopleAdminOutput {
  write(value: unknown): void;
}

const defaultPaths: PeopleAdminPaths = {
  peopleFile: fileURLToPath(new URL("./people.json", import.meta.url)),
  assetsDirectory: fileURLToPath(new URL("./assets/people", import.meta.url)),
};

const extensionMimeTypes: Readonly<Record<string, string>> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const usage = `用法：
  npm run people -w @photo-story/server -- list
  npm run people -w @photo-story/server -- get <人物ID>
  npm run people -w @photo-story/server -- add --id <人物ID> --display-name <展示名> --photo <图片路径> --source-note <来源说明> [--authorization authorized|placeholder]
  npm run people -w @photo-story/server -- delete <人物ID>`;

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function readPeopleFile(path: string): Promise<PersonEntry[]> {
  return parsePeople(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writePeopleFile(path: string, people: PersonEntry[]): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsePeople(people), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, path);
  } finally {
    await removeIfExists(temporaryPath);
  }
}

async function withLibraryLock<T>(
  paths: PeopleAdminPaths,
  action: () => Promise<T>,
): Promise<T> {
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

function parseAddOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`add 参数必须使用 --名称 值 的形式\n${usage}`);
    }
    if (options[name] !== undefined) {
      throw new Error(`参数重复：${name}`);
    }
    options[name] = value;
  }
  const allowed = new Set([
    "--id",
    "--display-name",
    "--photo",
    "--source-note",
    "--authorization",
  ]);
  const unknown = Object.keys(options).find((name) => !allowed.has(name));
  if (unknown) {
    throw new Error(`未知参数：${unknown}\n${usage}`);
  }
  for (const required of ["--id", "--display-name", "--photo", "--source-note"]) {
    if (!options[required]) {
      throw new Error(`缺少参数：${required}\n${usage}`);
    }
  }
  return options;
}

async function addPerson(
  args: string[],
  paths: PeopleAdminPaths,
): Promise<{ action: "added"; person: PersonEntry }> {
  const options = parseAddOptions(args);
  const id = options["--id"]!;
  const inputPhoto = resolve(options["--photo"]!);
  const extension = extname(inputPhoto).toLowerCase();
  const mimeType = extensionMimeTypes[extension];
  if (!mimeType) {
    throw new Error("照片只支持 JPEG、PNG 或 WebP");
  }
  const authorization = options["--authorization"] ?? "authorized";
  const photo = await readFile(inputPhoto);
  try {
    if (photo.length > MAX_PHOTO_BYTES) {
      throw new Error("照片不能超过 6 MiB");
    }
    if (!hasValidImageSignature(photo, mimeType)) {
      throw new Error("照片内容与扩展名不匹配，或图片格式无效");
    }

    return await withLibraryLock(paths, async () => {
      const people = await readPeopleFile(paths.peopleFile);
      if (people.some((person) => person.id === id)) {
        throw new Error(`人物已存在：${id}`);
      }
      const storedExtension = mimeType === "image/jpeg" ? ".jpg" : extension;
      const oldPhotoFile = `${randomUUID()}${storedExtension}`;
      const person = parsePeople([
        {
          id,
          displayName: options["--display-name"],
          oldPhotoUrl: `/api/people/${id}/photo`,
          oldPhotoFile,
          authorization,
          sourceNote: options["--source-note"],
        },
      ])[0]!;
      const destination = resolve(paths.assetsDirectory, oldPhotoFile);

      await mkdir(paths.assetsDirectory, { recursive: true });
      await writeFile(destination, photo, { flag: "wx", mode: 0o600 });
      try {
        await writePeopleFile(paths.peopleFile, [...people, person]);
      } catch (error) {
        await removeIfExists(destination);
        throw error;
      }
      return { action: "added" as const, person };
    });
  } finally {
    photo.fill(0);
  }
}

async function deletePerson(
  id: string,
  paths: PeopleAdminPaths,
): Promise<{ action: "deleted"; person: PersonEntry }> {
  return withLibraryLock(paths, async () => {
    const people = await readPeopleFile(paths.peopleFile);
    const person = people.find((entry) => entry.id === id);
    if (!person) {
      throw new Error(`人物不存在：${id}`);
    }

    const source = resolve(paths.assetsDirectory, person.oldPhotoFile);
    const staged = resolve(paths.assetsDirectory, `.delete-${randomUUID()}`);
    await rename(source, staged);
    try {
      await writePeopleFile(
        paths.peopleFile,
        people.filter((entry) => entry.id !== id),
      );
    } catch (error) {
      await rename(staged, source);
      throw error;
    }
    await unlink(staged);
    return { action: "deleted", person };
  });
}

function requireSingleId(args: string[]): string {
  if (args.length !== 1 || !args[0]) {
    throw new Error(usage);
  }
  return args[0];
}

export async function runPeopleAdmin(
  args: string[],
  paths: PeopleAdminPaths = defaultPaths,
  output: PeopleAdminOutput = { write: (value) => console.log(JSON.stringify(value, null, 2)) },
): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === "list") {
    if (commandArgs.length > 0) {
      throw new Error(usage);
    }
    output.write(await readPeopleFile(paths.peopleFile));
    return;
  }
  if (command === "get") {
    const id = requireSingleId(commandArgs);
    const person = (await readPeopleFile(paths.peopleFile)).find((entry) => entry.id === id);
    if (!person) {
      throw new Error(`人物不存在：${id}`);
    }
    output.write(person);
    return;
  }
  if (command === "add") {
    output.write(await addPerson(commandArgs, paths));
    return;
  }
  if (command === "delete") {
    output.write(await deletePerson(requireSingleId(commandArgs), paths));
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
