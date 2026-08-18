const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const multer = require("multer");
const fs = require("fs").promises;
const ffmpeg = require("fluent-ffmpeg");
const sharp = require("sharp");
const admin = require("firebase-admin");
const cors = require("cors");

const os = require("os");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getDiskStats } = require("./disk");
const s3 = require("./minioClient");
const {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} = require("@aws-sdk/client-s3");

const serviceAccountPath = path.resolve(
  __dirname,
  process.env.FIREBASE_ADMIN_SDK || "firebase-admin-key.json"
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
  });
}

const metadata = require("./metadataStore");
const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      })
    );
  });
  next();
});

async function minioReady() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: "healthcheck-probe" }));
    return true;
  } catch (err) {
    const code = err?.name || err?.Code || "";
    return code === "NotFound" || err?.$metadata?.httpStatusCode === 404 || err?.$metadata?.httpStatusCode === 301;
  }
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "my_drive",
    time: new Date().toISOString(),
    hostname: os.hostname(),
  });
});

app.get("/ready", async (_req, res) => {
  const disk = await getDiskStats().catch(() => null);
  let objectStore = false;
  try {
    objectStore = await minioReady();
  } catch (err) {
    objectStore = false;
  }
  const ready = Boolean(disk) && objectStore;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    objectStore,
    disk,
  });
});

const TEMP_FOLDER = path.join(__dirname, "temp");
const GB = 1024 * 1024 * 1024;
const DEFAULT_STORAGE_LIMIT = Number(process.env.DEFAULT_STORAGE_GB || 5) * GB;
const MIN_STORAGE_LIMIT = 100 * 1024 * 1024;
const MAX_STORAGE_LIMIT = Number(process.env.MAX_STORAGE_GB || 1024) * GB;
const MULTIPART_PART_SIZE = Number(process.env.MULTIPART_PART_SIZE || 8 * 1024 * 1024);

(async () => {
  try {
    await fs.mkdir(TEMP_FOLDER, { recursive: true });
  } catch (err) {
    console.error("Error creating temp folder:", err);
  }
})();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const verifyFirebaseToken = async (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const idToken = authHeader.substring(7);

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.uid = decodedToken.uid;
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

const isApiPath = (pathname) =>
  /^\/(files|upload|storage|thumbnail|preview|download|user)(\/|$)/.test(pathname);

app.use((req, res, next) => {
  if (!isApiPath(req.path)) {
    return next();
  }
  return verifyFirebaseToken(req, res, next);
});

const isImageFile = (mimetype) => mimetype.startsWith("image/");
const isVideoFile = (mimetype) => mimetype.startsWith("video/");

const generateImageThumbnail = async (buffer) => {
  try {
    return await sharp(buffer)
      .resize(200, 200, { fit: "cover", position: "center" })
      .toBuffer();
  } catch (err) {
    console.error("Error generating image thumbnail:", err);
    return null;
  }
};

const generateVideoThumbnail = async (buffer) => {
  const tempInputPath = path.join(TEMP_FOLDER, `video-${Date.now()}-input.mp4`);
  const tempOutputPath = path.join(TEMP_FOLDER, `video-${Date.now()}-output.png`);

  try {
    await fs.writeFile(tempInputPath, buffer);

    return await new Promise((resolve, reject) => {
      ffmpeg(tempInputPath)
        .on("error", reject)
        .on("end", async () => {
          try {
            const thumbnailBuffer = await fs.readFile(tempOutputPath);
            const resized = await sharp(thumbnailBuffer)
              .resize(200, 200, { fit: "cover", position: "center" })
              .toBuffer();

            await fs.unlink(tempInputPath).catch(() => {});
            await fs.unlink(tempOutputPath).catch(() => {});
            resolve(resized);
          } catch (err) {
            reject(err);
          }
        })
        .screenshots({
          timestamps: [1],
          filename: path.basename(tempOutputPath),
          folder: path.dirname(tempOutputPath),
        });
    });
  } catch (err) {
    console.error("Error generating video thumbnail:", err);
    await fs.unlink(tempInputPath).catch(() => {});
    await fs.unlink(tempOutputPath).catch(() => {});
    return null;
  }
};

const userBucketName = (uid) => {
  const safe = String(uid || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  return `u-${safe}`.slice(0, 63);
};

const getUserLimit = (uid) => {
  const user = metadata.getUser(uid);
  return Number(user?.storageLimit) > 0 ? Number(user.storageLimit) : DEFAULT_STORAGE_LIMIT;
};

const getUserBucket = (uid) => {
  const user = metadata.getUser(uid);
  return user?.bucketName || userBucketName(uid);
};

const fileBucket = (file, uid) =>
  file?.bucketName || getUserBucket(uid);

async function ensureBucket(bucketName) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return bucketName;
  } catch (err) {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
    console.log(`Bucket "${bucketName}" created.`);
    return bucketName;
  }
}

async function ensureUserStorage(uid) {
  const bucketName = userBucketName(uid);
  await ensureBucket(bucketName);
  const existing = metadata.getUser(uid);
  if (!existing?.bucketName || !existing?.storageLimit) {
    await metadata.upsertUser(uid, {
      bucketName,
      storageLimit: existing?.storageLimit || DEFAULT_STORAGE_LIMIT,
    });
  }
  return metadata.getUser(uid);
}

const uploadToMinIO = async (bucketName, key, buffer, contentType) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
};

const formatFileSize = (bytes) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const listUserFiles = (uid) => metadata.listFiles(uid);

const calculateUserStorageUsed = (uid) => {
  return metadata.listFiles(uid, { includePending: true }).reduce(
    (sum, file) => sum + (file.fileSize || 0),
    0
  );
};

const getOwnedFile = (fileId, uid) => {
  const file = metadata.getFile(fileId);
  if (!file || file.isDeleted) {
    return { error: { status: 404, message: "File not found" } };
  }
  if (file.uid !== uid) {
    return { error: { status: 403, message: "Unauthorized" } };
  }
  return { file };
};

app.get("/files", async (req, res) => {
  try {
    const files = await listUserFiles(req.uid);
    res.json({ files });
  } catch (err) {
    console.error("LIST ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/recent", async (req, res) => {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const files = (await listUserFiles(req.uid)).filter((file) => {
      const accessed = new Date(file.lastAccessedAt || file.createdAt || 0).getTime();
      return accessed >= sevenDaysAgo;
    });
    files.sort(
      (a, b) =>
        new Date(b.lastAccessedAt || b.createdAt || 0) -
        new Date(a.lastAccessedAt || a.createdAt || 0)
    );
    res.json({ files });
  } catch (err) {
    console.error("RECENT FILES ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/starred", async (req, res) => {
  try {
    const files = (await listUserFiles(req.uid)).filter((file) => file.isStarred);
    res.json({ files });
  } catch (err) {
    console.error("STARRED FILES ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/files/:fileId/star", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    const newStarredState = !file.isStarred;
    await metadata.updateFile(file.id, { isStarred: newStarredState });

    res.json({
      message: `File ${newStarredState ? "starred" : "unstarred"}`,
      isStarred: newStarredState,
    });
  } catch (err) {
    console.error("STAR TOGGLE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/storage", async (req, res) => {
  try {
    await ensureUserStorage(req.uid);
    const disk = await getDiskStats().catch(() => null);
    const used = calculateUserStorageUsed(req.uid);
    const limit = getUserLimit(req.uid);
    const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
    res.json({
      used,
      limit,
      percentage,
      usedFormatted: formatFileSize(used),
      limitFormatted: formatFileSize(limit),
      storageLimitGB: Number((limit / GB).toFixed(2)),
      bucketName: getUserBucket(req.uid),
      node: disk
        ? {
            hostname: disk.hostname,
            platform: disk.platform,
            free: disk.free,
            total: disk.total,
            freeFormatted: formatFileSize(disk.free),
            totalFormatted: formatFileSize(disk.total),
          }
        : null,
    });
  } catch (err) {
    console.error("STORAGE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/thumbnail/:fileId", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    const thumbnailKey = file.thumbnailPath;
    if (!thumbnailKey) {
      return res.status(404).json({ error: "Thumbnail not found" });
    }

    const data = await s3.send(
      new GetObjectCommand({ Bucket: fileBucket(file, req.uid), Key: thumbnailKey })
    );
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", data.ContentType || "image/png");
    data.Body.pipe(res);
  } catch (err) {
    console.error("THUMBNAIL ERROR:", err);
    res.status(404).json({ error: "Thumbnail not found" });
  }
});

app.get("/preview/:fileId", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    await metadata.updateFile(file.id, { lastAccessedAt: new Date().toISOString() });

    const fileData = file;
    const data = await s3.send(
      new GetObjectCommand({ Bucket: fileBucket(fileData, req.uid), Key: fileData.minioKey })
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileData.originalName}"`
    );
    res.setHeader("Content-Type", data.ContentType || "application/octet-stream");
    data.Body.pipe(res);
  } catch (err) {
    console.error("PREVIEW ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/download/:fileId", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    const fileData = file;
    const data = await s3.send(
      new GetObjectCommand({ Bucket: fileBucket(fileData, req.uid), Key: fileData.minioKey })
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileData.originalName}"`
    );
    res.setHeader("Content-Type", data.ContentType || "application/octet-stream");
    data.Body.pipe(res);
  } catch (err) {
    console.error("DOWNLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/:fileId/signed-url", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT;
    if (!publicEndpoint) {
      return res.json({
        mode: "proxy",
        url: `/download/${file.id}`,
        expiresIn: null,
        note: "Object storage is private. Downloads go through the API with your auth token.",
      });
    }

    const command = new GetObjectCommand({
      Bucket: fileBucket(file, req.uid),
      Key: file.minioKey,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({
      mode: "presigned",
      url,
      expiresIn: 300,
    });
  } catch (err) {
    console.error("SIGNED URL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file received" });
    }

    const file = req.file;
    const profile = await ensureUserStorage(req.uid);
    const currentUsage = calculateUserStorageUsed(req.uid);
    const limit = profile.storageLimit || DEFAULT_STORAGE_LIMIT;
    if (currentUsage + file.size > limit) {
      return res.status(413).json({
        error: "Storage quota exceeded",
        used: currentUsage,
        limit,
      });
    }

    const bucketName = profile.bucketName;
    const minioKey = `${Date.now()}-${file.originalname}`;
    await uploadToMinIO(bucketName, minioKey, file.buffer, file.mimetype);

    const saved = await metadata.createFile({
      uid: req.uid,
      originalName: file.originalname,
      minioKey,
      bucketName,
      fileSize: file.size,
      mimeType: file.mimetype,
      thumbnailPath: null,
      isStarred: false,
      isDeleted: false,
    });

    (async () => {
      try {
        let thumbnailBuffer = null;
        if (isImageFile(file.mimetype)) {
          thumbnailBuffer = await generateImageThumbnail(file.buffer);
        } else if (isVideoFile(file.mimetype)) {
          thumbnailBuffer = await generateVideoThumbnail(file.buffer);
        }

        if (thumbnailBuffer) {
          const thumbnailKey = `thumbnails/${Date.now()}-${file.originalname}.png`;
          await uploadToMinIO(bucketName, thumbnailKey, thumbnailBuffer, "image/png");
          await metadata.updateFile(saved.id, { thumbnailPath: thumbnailKey });
        }
      } catch (err) {
        console.error("Error processing thumbnail:", err);
      }
    })();

    res.json({
      message: "File uploaded successfully",
      fileId: saved.id,
      fileName: file.originalname,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/upload/init", uploadLimiter, async (req, res) => {
  try {
    const originalName = String(req.body?.originalName || "").trim();
    const fileSize = Number(req.body?.fileSize);
    const mimeType = req.body?.mimeType || "application/octet-stream";

    if (!originalName || !Number.isFinite(fileSize) || fileSize < 0) {
      return res.status(400).json({ error: "originalName and fileSize are required" });
    }

    const profile = await ensureUserStorage(req.uid);
    const currentUsage = calculateUserStorageUsed(req.uid);
    const limit = profile.storageLimit || DEFAULT_STORAGE_LIMIT;
    if (currentUsage + fileSize > limit) {
      return res.status(413).json({
        error: "Storage quota exceeded",
        used: currentUsage,
        limit,
      });
    }

    const bucketName = profile.bucketName;
    const minioKey = `${Date.now()}-${originalName}`;
    const created = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: minioKey,
        ContentType: mimeType,
      })
    );

    const saved = await metadata.createFile({
      uid: req.uid,
      originalName,
      minioKey,
      bucketName,
      fileSize,
      mimeType,
      thumbnailPath: null,
      isStarred: false,
      isDeleted: false,
      status: "uploading",
      uploadId: created.UploadId,
      parts: [],
      partSize: MULTIPART_PART_SIZE,
    });

    res.json({
      fileId: saved.id,
      uploadId: created.UploadId,
      bucketName,
      minioKey,
      partSize: MULTIPART_PART_SIZE,
    });
  } catch (err) {
    console.error("UPLOAD INIT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/upload/:fileId", async (req, res) => {
  try {
    const file = metadata.getFile(req.params.fileId);
    if (!file || file.uid !== req.uid) {
      return res.status(404).json({ error: "Upload not found" });
    }

    let parts = file.parts || [];
    if (file.status === "uploading" && file.uploadId) {
      try {
        const listed = await s3.send(
          new ListPartsCommand({
            Bucket: fileBucket(file, req.uid),
            Key: file.minioKey,
            UploadId: file.uploadId,
          })
        );
        parts = (listed.Parts || []).map((part) => ({
          partNumber: part.PartNumber,
          etag: part.ETag,
        }));
        await metadata.updateFile(file.id, { parts });
      } catch (err) {
        console.error("LIST PARTS ERROR:", err);
      }
    }

    res.json({
      fileId: file.id,
      originalName: file.originalName,
      fileSize: file.fileSize,
      status: file.status || "complete",
      partSize: file.partSize || MULTIPART_PART_SIZE,
      parts,
    });
  } catch (err) {
    console.error("UPLOAD STATUS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put(
  "/upload/:fileId/parts/:partNumber",
  express.raw({ type: "*/*", limit: "16mb" }),
  async (req, res) => {
    try {
      const file = metadata.getFile(req.params.fileId);
      if (!file || file.uid !== req.uid || file.status !== "uploading") {
        return res.status(404).json({ error: "Upload session not found" });
      }

      const partNumber = Number(req.params.partNumber);
      if (!Number.isInteger(partNumber) || partNumber < 1) {
        return res.status(400).json({ error: "Invalid part number" });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

      const result = await s3.send(
        new UploadPartCommand({
          Bucket: fileBucket(file, req.uid),
          Key: file.minioKey,
          UploadId: file.uploadId,
          PartNumber: partNumber,
          Body: body,
        })
      );

      const etag = result.ETag;
      const parts = [...(file.parts || []).filter((p) => p.partNumber !== partNumber), {
        partNumber,
        etag,
      }].sort((a, b) => a.partNumber - b.partNumber);

      await metadata.updateFile(file.id, { parts });
      res.json({ partNumber, etag });
    } catch (err) {
      console.error("UPLOAD PART ERROR:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.post("/upload/:fileId/complete", async (req, res) => {
  try {
    const file = metadata.getFile(req.params.fileId);
    if (!file || file.uid !== req.uid || file.status !== "uploading") {
      return res.status(404).json({ error: "Upload session not found" });
    }

    const incoming = Array.isArray(req.body?.parts) ? req.body.parts : file.parts || [];
    const parts = incoming
      .map((part) => ({
        PartNumber: Number(part.partNumber || part.PartNumber),
        ETag: part.etag || part.ETag,
      }))
      .filter((part) => part.PartNumber && part.ETag)
      .sort((a, b) => a.PartNumber - b.PartNumber);

    if (!parts.length) {
      return res.status(400).json({ error: "No uploaded parts to complete" });
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: fileBucket(file, req.uid),
        Key: file.minioKey,
        UploadId: file.uploadId,
        MultipartUpload: { Parts: parts },
      })
    );

    await metadata.updateFile(file.id, {
      status: "complete",
      uploadId: null,
      parts,
    });

    (async () => {
      try {
        if (!isImageFile(file.mimeType) || file.fileSize > 20 * 1024 * 1024) return;
        const obj = await s3.send(
          new GetObjectCommand({
            Bucket: fileBucket(file, req.uid),
            Key: file.minioKey,
          })
        );
        const chunks = [];
        for await (const chunk of obj.Body) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const thumbnailBuffer = await generateImageThumbnail(buffer);
        if (!thumbnailBuffer) return;
        const thumbnailKey = `thumbnails/${Date.now()}-${file.originalName}.png`;
        await uploadToMinIO(file.bucketName, thumbnailKey, thumbnailBuffer, "image/png");
        await metadata.updateFile(file.id, { thumbnailPath: thumbnailKey });
      } catch (err) {
        console.error("Error processing thumbnail:", err);
      }
    })();

    res.json({
      message: "File uploaded successfully",
      fileId: file.id,
      fileName: file.originalName,
    });
  } catch (err) {
    console.error("UPLOAD COMPLETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/upload/:fileId", async (req, res) => {
  try {
    const file = metadata.getFile(req.params.fileId);
    if (!file || file.uid !== req.uid) {
      return res.status(404).json({ error: "Upload not found" });
    }

    if (file.status === "uploading" && file.uploadId) {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: fileBucket(file, req.uid),
          Key: file.minioKey,
          UploadId: file.uploadId,
        })
      ).catch(() => {});
    }

    await metadata.updateFile(file.id, {
      isDeleted: true,
      status: "aborted",
      deletedAt: new Date().toISOString(),
    });
    res.json({ message: "Upload aborted" });
  } catch (err) {
    console.error("UPLOAD ABORT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/files/:fileId", async (req, res) => {
  try {
    const { file, error } = getOwnedFile(req.params.fileId, req.uid);
    if (error) return res.status(error.status).json({ error: error.message });

    const fileData = file;
    await metadata.updateFile(file.id, {
      isDeleted: true,
      deletedAt: new Date().toISOString(),
    });

    try {
      const bucket = fileBucket(fileData, req.uid);
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: fileData.minioKey })
      );
      if (fileData.thumbnailPath) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: fileData.thumbnailPath,
          })
        );
      }
    } catch (err) {
      console.error("MinIO deletion error:", err);
    }

    res.json({ message: "File deleted successfully" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/user/profile", async (req, res) => {
  try {
    const user = await ensureUserStorage(req.uid);
    res.json({ uid: req.uid, ...user });
  } catch (err) {
    console.error("PROFILE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/user/profile", async (req, res) => {
  try {
    const { displayName, email, photoURL, provider } = req.body || {};
    await metadata.upsertUser(req.uid, {
      displayName,
      email,
      photoURL,
      provider,
    });
    const user = await ensureUserStorage(req.uid);
    res.json({ message: "Profile saved successfully", user: { uid: req.uid, ...user } });
  } catch (err) {
    console.error("PROFILE UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/user/storage", async (req, res) => {
  try {
    await ensureUserStorage(req.uid);
    const gb = Number(req.body?.storageLimitGB);
    if (!Number.isFinite(gb) || gb <= 0) {
      return res.status(400).json({ error: "storageLimitGB must be a positive number" });
    }

    const nextLimit = gb * GB;
    if (nextLimit < MIN_STORAGE_LIMIT) {
      return res.status(400).json({ error: "Minimum storage is 0.1 GB" });
    }
    if (nextLimit > MAX_STORAGE_LIMIT) {
      return res.status(400).json({
        error: `Maximum storage is ${MAX_STORAGE_LIMIT / GB} GB`,
      });
    }

    const disk = await getDiskStats().catch(() => null);
    const used = calculateUserStorageUsed(req.uid);
    if (nextLimit < used) {
      return res.status(400).json({
        error: "Limit cannot be smaller than storage already used",
        used,
        usedFormatted: formatFileSize(used),
      });
    }
    if (disk && nextLimit > used + disk.free) {
      return res.status(400).json({
        error: `This device only has ${formatFileSize(disk.free)} free. Choose a smaller bucket size.`,
        free: disk.free,
        freeFormatted: formatFileSize(disk.free),
      });
    }

    await metadata.upsertUser(req.uid, { storageLimit: nextLimit });
    res.json({
      message: "Storage limit updated",
      storageLimit: nextLimit,
      storageLimitGB: Number((nextLimit / GB).toFixed(2)),
      used,
      bucketName: getUserBucket(req.uid),
    });
  } catch (err) {
    console.error("STORAGE LIMIT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

const frontendBuild =
  process.env.FRONTEND_BUILD_PATH ||
  path.join(__dirname, "..", "my-drive-frontend", "build");

app.use(express.static(frontendBuild));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return next();
  }
  if (isApiPath(req.path)) {
    return next();
  }
  res.sendFile(path.join(frontendBuild, "index.html"), (err) => {
    if (err) next();
  });
});

(async () => {
  await metadata.load();

  const server = app.listen(PORT, "0.0.0.0");

  server.on("listening", () => {
    console.log(`my_drive running on http://localhost:${PORT}`);
    console.log("From another network, expose this port with: npm run expose");
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the other process, then run npm start again.`
      );
      console.error(`Example: ss -tlnp | grep ${PORT}`);
    } else {
      console.error("Failed to start server:", err);
    }
    process.exit(1);
  });

  process.once("SIGINT", () => server.close(() => process.exit(0)));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
})().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
