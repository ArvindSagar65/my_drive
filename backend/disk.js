const fs = require("fs").promises;
const os = require("os");
const path = require("path");

async function getDiskStats(targetPath = process.env.STORAGE_PATH || process.cwd()) {
  const resolved = path.resolve(targetPath);
  const stats = await fs.statfs(resolved);
  const blockSize = Number(stats.bsize);
  const total = Number(stats.blocks) * blockSize;
  const free = Number(stats.bavail) * blockSize;
  return {
    path: resolved,
    hostname: os.hostname(),
    platform: os.platform(),
    total,
    free,
    used: total - free,
  };
}

module.exports = { getDiskStats };
