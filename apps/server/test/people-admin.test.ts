import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runPeopleAdmin,
  type PeopleAdminPaths,
} from "../src/people-admin.js";
import type { PersonEntry } from "../src/people.js";

const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("人物库管理脚本", () => {
  let root: string;
  let paths: PeopleAdminPaths;
  let outputs: unknown[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "people-admin-"));
    paths = {
      peopleFile: join(root, "people.json"),
      assetsDirectory: join(root, "assets"),
    };
    outputs = [];
    await mkdir(paths.assetsDirectory);
    await writeFile(paths.peopleFile, "[]\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("支持增加、查询和删除照片", async () => {
    const inputPhoto = join(root, "input.jpg");
    await writeFile(inputPhoto, validJpeg);
    const output = { write: (value: unknown) => outputs.push(value) };

    await runPeopleAdmin([
      "add",
      "--id",
      "person-one",
      "--display-name",
      "人物一",
      "--photo",
      inputPhoto,
      "--source-note",
      "已完成用途授权。",
    ], paths, output);

    const added = outputs[0] as { action: string; person: PersonEntry };
    expect(added.action).toBe("added");
    expect(added.person).toMatchObject({
      id: "person-one",
      displayName: "人物一",
      authorization: "authorized",
      oldPhotoUrl: "/api/people/person-one/photo",
    });
    expect(added.person.oldPhotoFile).toMatch(/^[0-9a-f-]+\.jpg$/);
    expect(await readFile(join(paths.assetsDirectory, added.person.oldPhotoFile))).toEqual(
      validJpeg,
    );

    outputs = [];
    await runPeopleAdmin(["get", "person-one"], paths, output);
    expect(outputs).toEqual([added.person]);
    outputs = [];
    await runPeopleAdmin(["list"], paths, output);
    expect(outputs).toEqual([[added.person]]);

    outputs = [];
    await runPeopleAdmin(["delete", "person-one"], paths, output);
    expect(outputs).toEqual([{ action: "deleted", person: added.person }]);
    expect(JSON.parse(await readFile(paths.peopleFile, "utf8"))).toEqual([]);
    await expect(readFile(join(paths.assetsDirectory, added.person.oldPhotoFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("拒绝重复人物、非法标识和伪装图片", async () => {
    const inputPhoto = join(root, "input.jpg");
    await writeFile(inputPhoto, validJpeg);
    const baseArgs = [
      "add",
      "--id",
      "person-one",
      "--display-name",
      "人物一",
      "--photo",
      inputPhoto,
      "--source-note",
      "已授权",
    ];
    await runPeopleAdmin(baseArgs, paths, { write: () => undefined });
    await expect(
      runPeopleAdmin(baseArgs, paths, { write: () => undefined }),
    ).rejects.toThrow("人物已存在");

    await expect(
      runPeopleAdmin(
        [...baseArgs.slice(0, 2), "../escape", ...baseArgs.slice(3)],
        paths,
        { write: () => undefined },
      ),
    ).rejects.toThrow();

    const fakePhoto = join(root, "fake.png");
    await writeFile(fakePhoto, "not an image");
    await expect(
      runPeopleAdmin(
        [
          "add",
          "--id",
          "person-two",
          "--display-name",
          "人物二",
          "--photo",
          fakePhoto,
          "--source-note",
          "已授权",
        ],
        paths,
        { write: () => undefined },
      ),
    ).rejects.toThrow("图片格式无效");
  });
});
