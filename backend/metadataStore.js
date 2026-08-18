const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "metadata.json");

let cache = { users: {}, files: {} };
let writeQueue = Promise.resolve();

async function load() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      users: parsed.users || {},
      files: parsed.files || {},
    };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await persist();
  }
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

function mutate(fn) {
  writeQueue = writeQueue.then(async () => {
    fn(cache);
    await persist();
  });
  return writeQueue;
}

function listFiles(uid, { includePending = false } = {}) {
  return Object.values(cache.files)
    .filter((file) => {
      if (file.uid !== uid || file.isDeleted) return false;
      if (!includePending && file.status === "uploading") return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function getFile(fileId) {
  return cache.files[fileId] || null;
}

async function createFile(record) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const file = {
    id,
    ...record,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  };
  await mutate((state) => {
    state.files[id] = file;
  });
  return file;
}

async function updateFile(fileId, patch) {
  await mutate((state) => {
    if (!state.files[fileId]) return;
    state.files[fileId] = {
      ...state.files[fileId],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  });
  return cache.files[fileId];
}

function getUser(uid) {
  return cache.users[uid] || null;
}

async function upsertUser(uid, profile) {
  const now = new Date().toISOString();
  await mutate((state) => {
    const existing = state.users[uid] || {};
    state.users[uid] = {
      ...existing,
      ...profile,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
  });
  return cache.users[uid];
}

module.exports = {
  load,
  listFiles,
  getFile,
  createFile,
  updateFile,
  getUser,
  upsertUser,
};
