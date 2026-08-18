const { S3Client } = require("@aws-sdk/client-s3");

const endpoint = process.env.MINIO_ENDPOINT
  ? process.env.MINIO_ENDPOINT.startsWith("http")
    ? process.env.MINIO_ENDPOINT
    : `http://${process.env.MINIO_ENDPOINT}`
  : "http://localhost:9000";

const s3 = new S3Client({
  endpoint,
  region: process.env.MINIO_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "admin",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "arjun1388",
  },
  forcePathStyle: true,
});

module.exports = s3;
