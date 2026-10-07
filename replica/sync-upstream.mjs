import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const metadataPath = "replica/upstream.json";
const protectedRoots = new Set([".git", ".github", ".agents", ".codex", "replica"]);
const protectedFiles = new Set(["agents.md", "deploy_edgeone.zh.md", "edgeone.json"]);
const upstreamRepository = "https://github.com/FeiZhuLulu/real-api-pricing.git";

function parseArgs(args) {
  const options = { dryRun: false, targetDir: projectRoot, sourceDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--source-dir" || arg === "--target-dir") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg} requires a directory`);
      options[arg === "--source-dir" ? "sourceDir" : "targetDir"] = path.resolve(args[++i]);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function checkedPath(relative) {
  if (typeof relative !== "string" || !relative || path.posix.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) || /[\\\0\r\n]/.test(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe upstream path: ${JSON.stringify(relative)}`);
  }
  return relative;
}

function isProtected(relative) {
  const normalized = relative.normalize("NFC").toLowerCase();
  return protectedRoots.has(normalized.split("/")[0]) || protectedFiles.has(normalized);
}

async function maybeStat(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function inspectTarget(root, relative) {
  const parts = relative.split("/");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await maybeStat(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in target: ${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Target parent is not a directory: ${relative}`);
    }
    if (i === parts.length - 1 && !stat.isFile()) {
      throw new Error(`Target is not a regular file: ${relative}`);
    }
    if (i === parts.length - 1) return stat;
  }
}

function objectHash(bytes, algorithm) {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node replica/sync-upstream.mjs [--dry-run] [--source-dir GIT_REPO] [--target-dir PROJECT]\nReads committed Git objects only. Never commits, pushes, or executes upstream scripts.");
    return;
  }
  const root = await realpath(options.targetDir);
  const metadataFile = path.join(root, metadataPath);
  await inspectTarget(root, metadataPath);
  const previous = JSON.parse(await readFile(metadataFile, "utf8"));
  if (previous.schemaVersion !== 1 || previous.repository !== upstreamRepository ||
      previous.ref !== "refs/heads/main" || !Array.isArray(previous.managedFiles)) {
    throw new Error("Unsupported upstream configuration or manifest");
  }
  const previousFiles = new Set();
  for (const file of previous.managedFiles) {
    checkedPath(file);
    if (isProtected(file)) throw new Error(`Protected path in previous manifest: ${file}`);
    if (previousFiles.has(file)) throw new Error(`Duplicate path in previous manifest: ${file}`);
    previousFiles.add(file);
  }
  let temporary = null;
  const gitBinary = process.env.GIT_BIN || "git";
  const git = (repo, args, extra = {}) => execFileSync(gitBinary, ["-C", repo, ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...extra,
  });
  try {
    let source;
    let commit;
    if (options.sourceDir) {
      source = await realpath(options.sourceDir);
      commit = git(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    } else {
      temporary = await mkdtemp(path.join(os.tmpdir(), "real-api-pricing-sync-"));
      source = temporary;
      git(source, ["init", "--bare", "--quiet"]);
      git(source, ["fetch", "--quiet", "--no-tags", "--depth=1", previous.repository, previous.ref]);
      commit = git(source, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).trim();
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid upstream commit");
    const algorithm = git(source, ["rev-parse", "--show-object-format"]).trim();
    if (algorithm !== "sha1" && algorithm !== "sha256") throw new Error("Unsupported Git object format");
    const entries = [];
    const caseFolded = new Set();
    for (const record of git(source, ["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0")) {
      if (!record) continue;
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("Malformed Git tree entry");
      const [, mode, type, oid, relative] = match;
      checkedPath(relative);
      if (isProtected(relative)) continue;
      if (type !== "blob" || !["100644", "100755"].includes(mode)) {
        throw new Error(`Unsupported upstream file type: ${relative}`);
      }
      const folded = relative.normalize("NFC").toLowerCase();
      if (caseFolded.has(folded)) throw new Error(`Case-insensitive path collision: ${relative}`);
      caseFolded.add(folded);
      entries.push({ relative, oid, mode: mode === "100755" ? 0o755 : 0o644 });
    }
    entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
    if (!entries.length) throw new Error("Upstream snapshot is empty");
    const currentFiles = new Set(entries.map((entry) => entry.relative));
    const deleted = [...previousFiles].filter((file) => !currentFiles.has(file));
    const changes = [];
    let added = 0;
    let updated = 0;
    for (const entry of entries) {
      const stat = await inspectTarget(root, entry.relative);
      if (stat && !previousFiles.has(entry.relative)) {
        throw new Error(`New upstream path conflicts with an unmanaged local file: ${entry.relative}`);
      }
      const bytes = stat ? await readFile(path.join(root, entry.relative)) : null;
      const modeMatches = stat && Boolean(stat.mode & 0o111) === Boolean(entry.mode & 0o111);
      if (!bytes || objectHash(bytes, algorithm) !== entry.oid || !modeMatches) {
        changes.push(entry);
        if (stat) updated += 1; else added += 1;
      }
    }
    for (const file of deleted) await inspectTarget(root, file);
    const next = {
      schemaVersion: 1, repository: previous.repository, ref: previous.ref,
      commit, managedFiles: entries.map((entry) => entry.relative),
    };
    const metadata = `${JSON.stringify(next, null, 2)}\n`;
    const metadataChanged = metadata !== await readFile(metadataFile, "utf8");
    console.log(`${options.dryRun ? "Dry run" : "Upstream"}: ${commit}; ${added} added, ${updated} updated, ${deleted.length} removed; ${entries.length} managed files.`);
    if (options.dryRun) {
      console.log(`No files changed. Manifest ${metadataChanged ? "would be updated" : "is current"}.`);
      return;
    }

    // Fetch every required blob before touching the destination. The Git batch
    // protocol is length-delimited, so PNGs and other binary files stay exact.
    const content = changes.length ? git(source, ["cat-file", "--batch"], {
      input: changes.map((entry) => entry.oid).join("\n") + "\n", encoding: null,
    }) : Buffer.alloc(0);
    const blobs = [];
    let offset = 0;
    for (const entry of changes) {
      const end = content.indexOf(10, offset);
      if (end < 0) throw new Error("Truncated Git batch header");
      const match = /^([a-f0-9]+) blob (\d+)$/.exec(content.subarray(offset, end).toString("ascii"));
      if (!match || match[1] !== entry.oid) throw new Error("Unexpected Git batch object");
      const length = Number(match[2]);
      offset = end + 1;
      if (!Number.isSafeInteger(length) || length < 0 || offset + length >= content.length || content[offset + length] !== 10) {
        throw new Error("Truncated Git batch content");
      }
      const bytes = content.subarray(offset, offset + length);
      if (objectHash(bytes, algorithm) !== entry.oid) throw new Error(`Corrupt Git blob: ${entry.relative}`);
      blobs.push(bytes);
      offset += length + 1;
    }
    if (offset !== content.length) throw new Error("Unexpected trailing Git batch data");
    for (let i = 0; i < changes.length; i += 1) {
      const entry = changes[i];
      const destination = path.join(root, entry.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, blobs[i]);
      await chmod(destination, entry.mode);
    }
    // Only paths explicitly owned by the previous snapshot can be deleted.
    // Empty directories are intentionally left alone, preserving local files.
    for (const file of deleted) await rm(path.join(root, file), { force: true });
    if (metadataChanged) await writeFile(metadataFile, metadata);
    console.log("Snapshot applied. Run website tests and the replica build before committing.");
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Upstream sync failed: ${error.message}`);
  process.exitCode = 1;
});
