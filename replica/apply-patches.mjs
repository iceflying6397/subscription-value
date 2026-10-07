import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPatch = fileURLToPath(new URL("./patches/chart-zoom.patch", import.meta.url));
const allowedFiles = new Set([
  "web/src/Chart.tsx",
  "web/src/chartScene.ts",
  "web/src/domain.test.ts",
]);

function validatePatch(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("补丁必须是文本，不能包含二进制数据。");
  const sections = text.split(/(?=^diff --git )/m);
  const files = new Set();
  for (const section of sections) {
    if (!section.trim()) continue;
    const lines = section.split("\n");
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0]);
    if (!header || header[1] !== header[2] || !allowedFiles.has(header[1])) {
      throw new Error("补丁只能修改允许的三个现有图表源码/测试文件。");
    }
    const file = header[1];
    if (files.has(file)) throw new Error(`补丁中重复出现文件：${file}`);
    files.add(file);
    let i = 1;
    if (/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?$/.test(lines[i] ?? "")) i += 1;
    if (lines[i] !== `--- a/${file}` || lines[i + 1] !== `+++ b/${file}`) {
      throw new Error(`补丁不能新增、删除、重命名文件或改变文件类型：${file}`);
    }
    i += 2;
    let oldRemaining = 0;
    let newRemaining = 0;
    let hunks = 0;
    let previousWasContent = false;
    for (; i < lines.length; i += 1) {
      const line = lines[i];
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (hunk) {
        if (oldRemaining || newRemaining) throw new Error(`补丁区块行数不匹配：${file}`);
        oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
        if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) {
          throw new Error(`补丁行数无效：${file}`);
        }
        hunks += 1;
        previousWasContent = false;
      } else if (line === "\\ No newline at end of file") {
        if (!previousWasContent) throw new Error(`补丁换行标记无效：${file}`);
        previousWasContent = false;
      } else if (line === "" && i === lines.length - 1) {
        // A final newline is outside the last hunk's content.
      } else {
        if (!hunks || ![" ", "+", "-"].includes(line[0])) {
          throw new Error(`仅支持普通文本修改，补丁格式无效：${file}`);
        }
        if (line[0] !== "+") oldRemaining -= 1;
        if (line[0] !== "-") newRemaining -= 1;
        if (oldRemaining < 0 || newRemaining < 0) throw new Error(`补丁区块行数超出声明：${file}`);
        previousWasContent = true;
      }
    }
    if (!hunks || oldRemaining || newRemaining) throw new Error(`补丁区块不完整：${file}`);
  }
  if (!files.size) throw new Error("本地图表修复补丁为空。");
  return [...files];
}

async function assertRegularTarget(root, relative) {
  const parts = relative.split("/");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`上游补丁目标已不存在：${relative}`);
      throw error;
    }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`补丁目标必须是现有普通文件，且不能经过符号链接：${relative}`);
    }
  }
}

export async function applyPatches({ targetDir = projectRoot, patchFile = defaultPatch } = {}) {
  const root = await realpath(targetDir);
  const bytes = await readFile(patchFile);
  const files = validatePatch(bytes);
  for (const file of files) await assertRegularTarget(root, file);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "subscription-chart-patch-"));
  const checkedPatch = path.join(temporary, "chart-zoom.patch");
  try {
    // Git reads the same bytes that were validated, even if the original patch
    // is edited while a local build is running.
    await writeFile(checkedPatch, bytes);
    const git = (args) => {
      const result = spawnSync(process.env.GIT_BIN || "git", ["-C", root, "apply", ...args, "--", checkedPatch], {
        encoding: "utf8", shell: false, maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      return result;
    };
    const forward = git(["--check"]);
    const reverse = git(["--reverse", "--check"]);
    // Prefer the already-applied state if both checks happen to match an
    // insertion-only hunk, avoiding duplicate insertions on repeated builds.
    if (reverse.status === 0) {
      console.log("本地图表修复补丁已应用，跳过重复应用。");
      return { applied: false, files };
    }
    if (forward.status !== 0) {
      throw new Error(`上游图表代码与本地修复补丁冲突，已停止发布。请重新核对补丁。\n${forward.stderr.trim().slice(0, 2000)}`);
    }
    const applied = git([]);
    if (applied.status !== 0) throw new Error(`本地图表修复补丁应用失败：${applied.stderr.trim().slice(0, 2000)}`);
    if (git(["--reverse", "--check"]).status !== 0) throw new Error("补丁应用后校验失败，已停止发布。");
    console.log(`已应用本地图表修复补丁（${files.length} 个文件）。`);
    return { applied: true, files };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!["--target-dir", "--patch"].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
      console.error("用法：node replica/apply-patches.mjs [--target-dir PROJECT] [--patch PATCH_FILE]");
      process.exit(1);
    }
    options[arg === "--target-dir" ? "targetDir" : "patchFile"] = path.resolve(process.argv[++i]);
  }
  applyPatches(options).catch((error) => {
    console.error(`本地补丁检查失败：${error.message}`);
    process.exitCode = 1;
  });
}
