/** S3 and compatible services (AWS, Cloudflare R2, Wasabi, Backblaze B2, MinIO) via the AWS SDK. */
import { createReadStream } from 'node:fs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface S3Settings {
  /** Null for AWS itself (the SDK knows its endpoints). */
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKey: string;
  secretKey: string;
}

/** What the storage service needs from S3 (a fake in tests). */
export interface S3Ops {
  test(s: S3Settings): Promise<void>;
  upload(s: S3Settings, key: string, filePath: string): Promise<void>;
  signedGet(s: S3Settings, key: string, fileName: string): Promise<string>;
  remove(s: S3Settings, key: string): Promise<void>;
}

const TEST_KEY = '.impa-meet-teste.txt';

function client(s: S3Settings): S3Client {
  const config: S3ClientConfig = {
    region: s.region,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
    forcePathStyle: s.pathStyle,
    maxAttempts: 3,
    // Only what is asked for is checked: compatible services do not all support checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (s.endpoint) config.endpoint = s.endpoint;
  return new S3Client(config);
}

export const objectKey = (s: Pick<S3Settings, 'prefix'>, name: string) =>
  s.prefix ? `${s.prefix.replace(/\/+$/, '')}/${name}` : name;

/** Messages people can act on (the SDK's are technical and sometimes carry the endpoint). */
export function s3Error(err: unknown): string {
  const name = (err as { name?: string; Code?: string })?.name ?? '';
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Forbidden/i.test(name))
    return 'O provedor recusou a chave: confira a chave de acesso, o segredo e a permissão no bucket';
  if (/NoSuchBucket|NotFound/i.test(name)) return 'O bucket não foi encontrado: confira o nome e a região';
  if (/PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(name))
    return 'Região errada para este bucket';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|TimeoutError|NetworkingError/i.test(`${name} ${String(err)}`))
    return 'Não foi possível conectar ao endereço do armazenamento';
  return 'O armazenamento recusou a operação';
}

export const awsS3: S3Ops = {
  async test(s) {
    const c = client(s);
    try {
      const key = objectKey(s, TEST_KEY);
      await c.send(
        new PutObjectCommand({
          Bucket: s.bucket,
          Key: key,
          Body: 'IMPA Meet: teste de gravação.',
          ContentType: 'text/plain',
        }),
      );
      await c.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
    } finally {
      c.destroy();
    }
  },
  async upload(s, key, filePath) {
    const c = client(s);
    try {
      await new Upload({
        client: c,
        params: { Bucket: s.bucket, Key: key, Body: createReadStream(filePath), ContentType: 'video/mp4' },
        queueSize: 2,
        partSize: 16 * 1024 * 1024,
      }).done();
    } finally {
      c.destroy();
    }
  },
  async signedGet(s, key, fileName) {
    const c = client(s);
    try {
      return await getSignedUrl(
        c,
        new GetObjectCommand({
          Bucket: s.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="gravacao.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }),
        { expiresIn: 300 },
      );
    } finally {
      c.destroy();
    }
  },
  async remove(s, key) {
    const c = client(s);
    try {
      await c.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
    } finally {
      c.destroy();
    }
  },
};
