// File storage on Amazon S3. Attachments (request documents, LR copies, proof of
// receipt) used to be stored as base64 text inside the SQLite database; with S3
// enabled they are uploaded here instead and only a short reference such as
// "s3:uploads/2026/09/<uuid>.pdf" is kept in the record.
//
// S3 is optional: when S3_BUCKET is not set everything keeps working the old way
// (files stay inline in the database), so local development needs no AWS account.
//
// Credentials come from the standard AWS chain. On EC2, attach an IAM role to the
// instance and no keys are needed anywhere. S3_ENDPOINT is only for tests against
// an S3-compatible emulator.
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { S3_BUCKET, S3_REGION, AWS_REGION, S3_ENDPOINT } = process.env;

export const s3Enabled = !!S3_BUCKET;

let client;
export const getS3Client = () => {
  if (!client) {
    client = new S3Client({
      region: S3_REGION || AWS_REGION || 'ap-south-1',
      ...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT, forcePathStyle: true } : {})
    });
  }
  return client;
};

export const getBucket = () => S3_BUCKET;

// Only these types can be stored. The Content-Type saved with the object comes from
// this table (never from the client), so an upload can't be served back as HTML.
const TYPES = {
  pdf: { contentType: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  png: { contentType: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { contentType: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { contentType: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  doc: { contentType: 'application/msword', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  xls: { contentType: 'application/vnd.ms-excel', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] }
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // base64 in a 15 MB JSON body tops out near 11 MB

const DATA_URL = /^data:[^;,]*(?:;[^;,]*)*;base64,/i;

// Validates a base64 data URL + file name and returns { buffer, ext, contentType }
// or { error } describing what is wrong.
export const parseUpload = (dataUrl, name) => {
  if (typeof dataUrl !== 'string' || !DATA_URL.test(dataUrl)) return { error: 'File must be sent as a base64 data URL.' };
  if (typeof name !== 'string' || !name.trim()) return { error: 'File name is required.' };
  const ext = name.trim().split('.').pop().toLowerCase();
  const type = TYPES[ext];
  if (!type) return { error: 'Only PDF, Word, Excel, JPG and PNG files are allowed.' };

  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (buffer.length === 0) return { error: 'File is empty.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: `File is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).` };

  const looksRight = type.magic.some((sig) => sig.every((byte, i) => buffer[i] === byte));
  if (!looksRight) return { error: 'File content does not match its file type.' };
  return { buffer, ext: ext === 'jpeg' ? 'jpg' : ext, contentType: type.contentType };
};

const REF = /^s3:(uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,4})$/;

export const keyFromRef = (ref) => {
  const match = typeof ref === 'string' ? REF.exec(ref) : null;
  return match ? match[1] : null;
};

export const uploadFile = async ({ buffer, ext, contentType }) => {
  const now = new Date();
  const key = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
  await getS3Client().send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ServerSideEncryption: 'AES256'
  }));
  return `s3:${key}`;
};

// Short-lived link the browser can open directly; the bucket itself stays private.
export const presignedUrl = (key, expiresIn = 300) =>
  getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, ResponseContentDisposition: 'inline' }),
    { expiresIn }
  );
