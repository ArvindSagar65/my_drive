import { authorizedFetch, getApiUrl } from "./api";

const CONCURRENCY = 3;

async function mapPool(items, limit, worker) {
  const ret = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return ret;
}

export async function uploadFileMultipart(file, token, onProgress) {
  const api = getApiUrl();
  const resumeKey = `mydrive-upload:${file.name}:${file.size}:${file.lastModified}`;
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem(resumeKey) || "null");
  } catch {
    session = null;
  }

  if (session?.fileId) {
    const statusRes = await authorizedFetch(`${api}/upload/${session.fileId}`, token);
    if (!statusRes.ok) {
      session = null;
      localStorage.removeItem(resumeKey);
    } else {
      const status = await statusRes.json();
      if (status.status !== "uploading") {
        session = null;
        localStorage.removeItem(resumeKey);
      } else {
        session.parts = status.parts || [];
        session.partSize = status.partSize;
      }
    }
  }

  if (!session) {
    const initRes = await authorizedFetch(`${api}/upload/init`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: file.name,
        fileSize: file.size,
        mimeType: file.type || "application/octet-stream",
      }),
    });
    const init = await initRes.json();
    if (!initRes.ok) {
      throw new Error(init.error || "Failed to start upload");
    }
    session = {
      fileId: init.fileId,
      partSize: init.partSize,
      parts: [],
    };
    localStorage.setItem(resumeKey, JSON.stringify(session));
  }

  const partSize = session.partSize;
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const done = new Map((session.parts || []).map((p) => [p.partNumber, p.etag]));
  let finishedBytes = [...done.keys()].reduce((sum, n) => {
    const start = (n - 1) * partSize;
    return sum + Math.min(partSize, file.size - start);
  }, 0);
  onProgress?.(Math.round((finishedBytes / Math.max(file.size, 1)) * 100));

  const pending = [];
  for (let n = 1; n <= totalParts; n += 1) {
    if (!done.has(n)) pending.push(n);
  }

  await mapPool(pending, CONCURRENCY, async (partNumber) => {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, file.size);
    const blob = file.slice(start, end);
    const res = await authorizedFetch(
      `${api}/upload/${session.fileId}/parts/${partNumber}`,
      token,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob,
      }
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Part ${partNumber} failed`);
    }
    done.set(partNumber, data.etag);
    session.parts = [...done.entries()].map(([partNumber, etag]) => ({
      partNumber,
      etag,
    }));
    localStorage.setItem(resumeKey, JSON.stringify(session));
    finishedBytes += end - start;
    onProgress?.(Math.min(99, Math.round((finishedBytes / Math.max(file.size, 1)) * 100)));
  });

  const completeRes = await authorizedFetch(
    `${api}/upload/${session.fileId}/complete`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
      }),
    }
  );
  const complete = await completeRes.json();
  if (!completeRes.ok) {
    throw new Error(complete.error || "Failed to complete upload");
  }
  localStorage.removeItem(resumeKey);
  onProgress?.(100);
  return complete;
}

export async function uploadMany(fileList, token, onItem) {
  const files = [...fileList];
  const results = [];
  await mapPool(files, 3, async (file, index) => {
    try {
      onItem?.(index, { name: file.name, progress: 0, status: "uploading" });
      await uploadFileMultipart(file, token, (progress) => {
        onItem?.(index, { name: file.name, progress, status: "uploading" });
      });
      onItem?.(index, { name: file.name, progress: 100, status: "done" });
      results[index] = { ok: true, name: file.name };
    } catch (error) {
      onItem?.(index, {
        name: file.name,
        progress: 0,
        status: "error",
        error: error.message,
      });
      results[index] = { ok: false, name: file.name, error: error.message };
    }
  });
  return results;
}
