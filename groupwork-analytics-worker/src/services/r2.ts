import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function createR2Client(params: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  const { accountId, accessKeyId, secretAccessKey } = params;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function createUploadUrl(params: {
  s3: S3Client;
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresInSec?: number;
}) {
  const { s3, bucket, objectKey, contentType, expiresInSec = 900 } = params;
  const command = new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType });
  return getSignedUrl(s3, command, { expiresIn: expiresInSec });
}


