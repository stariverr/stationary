import { env } from "@/global/env";
import {
    S3Client,
    DeleteObjectCommand,
    HeadObjectCommand,
    CopyObjectCommand,
    NotFound,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
    region: env.S3_REGION,
    credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
});

class S3 {
    /** Access from Private Network (internal usage only) */
    public async getPresignedUrl(
        key: string,
        options: { bucket: string; expiresInSeconds?: number },
    ): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: options.bucket,
            Key: key.startsWith("/") ? key.slice(1) : key,
        });
        return getSignedUrl(s3Client as any, command, {
            expiresIn: options.expiresInSeconds ?? 900,
        });
    }

    public async delete(key: string, options: { bucket: string }): Promise<void> {
        const command = new DeleteObjectCommand({
            Bucket: options.bucket,
            Key: key.startsWith("/") ? key.slice(1) : key,
        });
        await s3Client.send(command);
    }

    public async write(
        key: string,
        data: Uint8Array | ReadableStream | Blob,
        options: {
            type: string;
            bucket: string;
            contentLength?: number;
        },
    ): Promise<void> {
        const parallelUploadS3 = new Upload({
            client: s3Client,
            params: {
                Bucket: options.bucket,
                Key: key.startsWith("/") ? key.slice(1) : key,
                Body: data,
                ContentType: options.type,
                ContentLength: options.contentLength,
            },
            // Optional tags, etc.
            queueSize: 4, // optional concurrency
            partSize: 1024 * 1024 * 5, // optional size of each part, in bytes
            leavePartsOnError: false, // optional manually handle failed uploads
        });

        // parallelUploadS3.on("httpUploadProgress", (progress) => {
        //     console.log(`上传进度: ${progress.loaded} / ${progress.total}`);
        // });

        await parallelUploadS3.done();
    }

    public async copy(
        sourceKey: string,
        destinationKey: string,
        options: { bucket: string },
    ): Promise<void> {
        const command = new CopyObjectCommand({
            Bucket: options.bucket,
            CopySource: `${options.bucket}/${sourceKey.startsWith("/") ? sourceKey.slice(1) : sourceKey}`,
            Key: destinationKey.startsWith("/") ? destinationKey.slice(1) : destinationKey,
        });
        await s3Client.send(command);
    }

    public async exists(key: string, options: { bucket: string }): Promise<boolean> {
        const path = key.startsWith("/") ? key.slice(1) : key;
        const command = new HeadObjectCommand({
            Bucket: options.bucket,
            Key: path,
        });
        try {
            await s3Client.send(command);
            return true;
        } catch (error) {
            if (error instanceof NotFound || (error as any).name === "NotFound") {
                return false;
            }
            throw error;
        }
    }
}

export const s3 = new S3();
