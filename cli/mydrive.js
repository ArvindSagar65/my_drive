#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".mydrive");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function usage() {
  console.log(`mydrive — push files into your self-hosted bucket

Usage:
  mydrive login --token <firebase-id-token> [--api <url>]
  mydrive push <file-or-folder>
  mydrive ls

Get a token from the my_drive web UI (account menu → Copy CLI token).
`);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function api(method, pathname, { body, headers, json } = {}) {
  const cfg = readConfig();
  if (!cfg.apiUrl || !cfg.token) {
    throw new Error("Not logged in. Run: mydrive login --token <id-token>");
  }
  const res = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${method} ${pathname} failed (${res.status})`);
  }
  return data;
}

async function walk(target, acc = []) {
  const stat = await fsp.stat(target);
  if (stat.isFile()) {
    acc.push(target);
    return acc;
  }
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".mp4": "video/mp4",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

async function uploadFile(filePath) {
  const stat = await fsp.stat(filePath);
  const originalName = path.basename(filePath);
  const init = await api("POST", "/upload/init", {
    json: {
      originalName,
      fileSize: stat.size,
      mimeType: mimeFromName(originalName),
    },
  });

  const partSize = init.partSize;
  const totalParts = Math.max(1, Math.ceil(stat.size / partSize));
  const fh = await fsp.open(filePath, "r");
  const parts = [];
  try {
    for (let n = 1; n <= totalParts; n += 1) {
      const start = (n - 1) * partSize;
      const length = Math.min(partSize, stat.size - start);
      const buffer = Buffer.alloc(length);
      await fh.read(buffer, 0, length, start);
      const data = await api("PUT", `/upload/${init.fileId}/parts/${n}`, {
        body: buffer,
        headers: { "Content-Type": "application/octet-stream" },
      });
      parts.push({ partNumber: n, etag: data.etag });
      const pct = Math.round((n / totalParts) * 100);
      process.stdout.write(`\r  ${originalName}  ${pct}%`);
    }
  } finally {
    await fh.close();
  }

  await api("POST", `/upload/${init.fileId}/complete`, { json: { parts } });
  process.stdout.write(`\r  ${originalName}  done          \n`);
}

async function cmdLogin(args) {
  let token;
  let apiUrl = readConfig().apiUrl || "http://localhost:5000";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--token") token = args[++i];
    if (args[i] === "--api") apiUrl = args[++i];
  }
  if (!token) {
    throw new Error("Pass --token <firebase-id-token> from the web UI");
  }
  writeConfig({ token, apiUrl });
  const profile = await api("GET", "/user/profile");
  console.log(`Logged in as ${profile.email || profile.displayName || profile.uid}`);
  console.log(`API ${apiUrl}`);
}

async function cmdPush(args) {
  const target = args[0];
  if (!target) throw new Error("Usage: mydrive push <file-or-folder>");
  const resolved = path.resolve(target);
  const files = await walk(resolved);
  if (!files.length) {
    console.log("No files found.");
    return;
  }
  console.log(`Uploading ${files.length} file(s) with S3 multipart...`);
  for (const file of files) {
    await uploadFile(file);
  }
}

async function cmdLs() {
  const data = await api("GET", "/files");
  const files = data.files || [];
  if (!files.length) {
    console.log("No files.");
    return;
  }
  for (const file of files) {
    console.log(`${file.fileSize}\t${file.originalName || file.name}`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  if (cmd === "login") return cmdLogin(args);
  if (cmd === "push") return cmdPush(args);
  if (cmd === "ls") return cmdLs();
  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
