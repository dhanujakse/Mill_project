// Takes a consistent snapshot of the SQLite database and uploads it (gzipped) to
// s3://$S3_BUCKET/backups/. Run it on a schedule (see deploy/ec2/millmate-backup.timer).
//
//   node scripts/backup-to-s3.mjs
//
// Uses the same environment as the server (DB_PATH, S3_BUCKET, S3_REGION).
// Old backups are removed by an S3 lifecycle rule (deploy/aws/s3-lifecycle.json),
// not by this script.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Enabled, getS3Client, getBucket } from '../storage.js';

if (!s3Enabled) {
  console.error('S3_BUCKET is not set - nothing to back up to.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(here, '..', 'data', 'alagiri.db');
const tmpFile = path.join(os.tmpdir(), `alagiri-backup-${process.pid}.db`);

try {
  // VACUUM INTO writes a complete, consistent copy even while the server is running.
  const db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${tmpFile.replace(/'/g, "''")}'`);
  db.close();

  const compressed = zlib.gzipSync(fs.readFileSync(tmpFile));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const key = `backups/alagiri-${stamp}.db.gz`;

  await getS3Client().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: compressed,
    ContentType: 'application/gzip',
    ServerSideEncryption: 'AES256'
  }));
  console.log(`Backup uploaded: s3://${getBucket()}/${key} (${(compressed.length / 1024).toFixed(0)} KB)`);
} catch (err) {
  console.error('Backup failed:', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmpFile, { force: true });
}
