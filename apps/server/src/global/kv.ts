// src/global/kv.ts
import { env } from "./env";
import { createClient } from "redis";
import { Temporal } from "@js-temporal/polyfill";

export type RedisClient = ReturnType<typeof createClient>;
export type KVValue = string | ArrayBuffer | ReadableStream;

export interface KVStore {
    // Basic operations
    get(key: string): Promise<KVValue | null>;
    put(key: string, value: KVValue, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string; limit?: number }): Promise<{ keys: string[] }>;

    // Batch operations
    getMany(keys: string[]): Promise<(KVValue | null)[]>;
    putMany(entries: { key: string; value: KVValue; expirationTtl?: number }[]): Promise<void>;

    // Redis-specific operations
    setNx(key: string, value: string, expirationTtl?: number): Promise<boolean>;
    expire(key: string, seconds: number): Promise<boolean>;
    setWithExpiration(key: string, value: string, seconds: number): Promise<void>;
    increment(key: string): Promise<number>;
    hset(key: string, field: string, value: string): Promise<void>;
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string>>;
    zadd(key: string, score: number, member: string): Promise<void>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    publish(channel: string, message: string): Promise<void>;
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;
}

/* Redis connection pool */
class RedisPool {
    private pool: { client: RedisClient; lastUsed: number }[] = [];
    private maxSize: number;
    private connectionTimeout: number; // milliseconds
    private cleanupInterval: NodeJS.Timeout | null = null;
    public url: string;

    constructor(url: string, maxSize: number = 10, connectionTimeout: number = 30000) {
        this.url = url;
        this.maxSize = maxSize;
        this.connectionTimeout = connectionTimeout;

        // Start periodic cleanup
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleConnections();
        }, connectionTimeout / 2);
    }

    async getClient(): Promise<RedisClient> {
        // Check for available connections in the pool
        while (this.pool.length > 0) {
            const { client, lastUsed } = this.pool.pop()!;

            // Check if connection has timed out
            if (Temporal.Now.instant().epochMilliseconds - lastUsed > this.connectionTimeout) {
                console.log("Closing timed out Redis connection");
                client.quit().catch(console.warn);
                continue; // Skip this connection and try the next one
            }

            // Validate that the connection is still alive
            if (await this.validateConnection(client)) {
                return client;
            } else {
                // If the connection is dead, create a new one
                client.quit().catch(console.warn);
                break; // Exit the loop to create a new connection
            }
        }

        return this.createNewClient();
    }

    private async createNewClient(): Promise<RedisClient> {
        const client = createClient({
            url: this.url,
            pingInterval: 50000,
        });
        client.on("error", (err) => console.error("Redis Pool Client Error:", err));
        await client.connect();
        return client;
    }

    returnClient(client: RedisClient): void {
        if (this.pool.length < this.maxSize) {
            this.pool.push({ client, lastUsed: Temporal.Now.instant().epochMilliseconds });
        } else {
            client.quit();
        }
    }

    async closeAll(): Promise<void> {
        await Promise.all(this.pool.map(({ client }) => client.quit()));
        this.pool = [];
    }

    async validateConnection(client: RedisClient): Promise<boolean> {
        try {
            await client.ping();
            return true;
        } catch (error) {
            console.warn("Invalid Redis connection:", error);
            return false;
        }
    }

    private cleanupStaleConnections(): void {
        const now = Temporal.Now.instant().epochMilliseconds;
        const activeConnections = [];

        for (const { client, lastUsed } of this.pool) {
            // Check if connection has timed out
            if (now - lastUsed > this.connectionTimeout) {
                console.log("Closing timed out Redis connection during cleanup");
                client.quit().catch(console.warn);
            } else {
                activeConnections.push({ client, lastUsed });
            }
        }

        this.pool = activeConnections;
    }

    // Clean up resources when shutting down
    async destroy(): Promise<void> {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        await this.closeAll();
    }
}

// Redis KV store using connection pooling
class PooledRedisKVStore implements KVStore {
    private pool: RedisPool;

    constructor(pool: RedisPool) {
        this.pool = pool;
    }

    async get(key: string): Promise<string | null> {
        const client = await this.pool.getClient();
        try {
            return await client.get(key);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async getMany(keys: string[]): Promise<(KVValue | null)[]> {
        const client = await this.pool.getClient();
        try {
            return await Promise.all(keys.map((key) => client.get(key)));
        } catch (error) {
            console.error("Error in getMany:", error);
            throw error;
        } finally {
            this.pool.returnClient(client);
        }
    }

    async put(key: string, value: KVValue, options?: { expirationTtl?: number }): Promise<void> {
        if (typeof value !== "string") {
            throw new Error("RedisKVStore only supports string values");
        }

        const client = await this.pool.getClient();
        try {
            if (options?.expirationTtl) {
                await client.setEx(key, options.expirationTtl, value);
            } else {
                await client.set(key, value);
            }
        } catch (error) {
            console.error(`Error putting key ${key}:`, error);
            throw error;
        } finally {
            this.pool.returnClient(client);
        }
    }

    async putMany(entries: { key: string; value: KVValue; expirationTtl?: number }[]): Promise<void> {
        const client = await this.pool.getClient();
        try {
            const pipeline = client.multi();
            for (const { key, value, expirationTtl } of entries) {
                if (typeof value !== "string") {
                    throw new Error("RedisKVStore only supports string values");
                }
                if (expirationTtl) {
                    pipeline.setEx(key, expirationTtl, value);
                } else {
                    pipeline.set(key, value);
                }
            }
            await pipeline.exec();
        } catch (error) {
            console.error("Error in putMany:", error);
            throw error;
        } finally {
            this.pool.returnClient(client);
        }
    }

    async delete(key: string): Promise<void> {
        const client = await this.pool.getClient();
        try {
            await client.del(key);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: string[] }> {
        const client = await this.pool.getClient();
        try {
            const keys = await client.keys(options?.prefix ? `${options.prefix}*` : "*");
            return { keys: options?.limit ? keys.slice(0, options.limit) : keys };
        } finally {
            this.pool.returnClient(client);
        }
    }

    async setNx(key: string, value: string, expirationTtl?: number): Promise<boolean> {
        const client = await this.pool.getClient();
        try {
            const options: any = { NX: true };
            if (expirationTtl) options.EX = expirationTtl;
            const result = await client.set(key, value, options);
            return result === "OK";
        } catch (error) {
            console.error(`Error in setNx for key ${key}:`, error);
            throw error;
        } finally {
            this.pool.returnClient(client);
        }
    }

    async expire(key: string, seconds: number): Promise<boolean> {
        const client = await this.pool.getClient();
        try {
            const result = await client.expire(key, seconds);
            return Boolean(result);
        } catch (error) {
            console.error(`Error in expire for key ${key}:`, error);
            throw error;
        } finally {
            this.pool.returnClient(client);
        }
    }

    async setWithExpiration(key: string, value: string, seconds: number): Promise<void> {
        const client = await this.pool.getClient();
        try {
            await client.setEx(key, seconds, value);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async increment(key: string): Promise<number> {
        const client = await this.pool.getClient();
        try {
            return await client.incr(key);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async hset(key: string, field: string, value: string): Promise<void> {
        const client = await this.pool.getClient();
        try {
            await client.hSet(key, field, value);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async hget(key: string, field: string): Promise<string | null> {
        const client = await this.pool.getClient();
        try {
            return await client.hGet(key, field);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async hgetall(key: string): Promise<Record<string, string>> {
        const client = await this.pool.getClient();
        try {
            return await client.hGetAll(key);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async zadd(key: string, score: number, member: string): Promise<void> {
        const client = await this.pool.getClient();
        try {
            await client.zAdd(key, { score, value: member });
        } finally {
            this.pool.returnClient(client);
        }
    }

    async zrange(key: string, start: number, stop: number): Promise<string[]> {
        const client = await this.pool.getClient();
        try {
            return await client.zRange(key, start, stop);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async publish(channel: string, message: string): Promise<void> {
        const client = await this.pool.getClient();
        try {
            await client.publish(channel, message);
        } finally {
            this.pool.returnClient(client);
        }
    }

    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
        // For subscribe, we need a dedicated client
        const client = createClient({
            url: this.pool.url,
            pingInterval: 50000,
        });
        client.on("error", (err) => console.error("Redis Subscribe Client Error:", err));
        await client.connect();
        await client.subscribe(channel, (message) => callback(message));
        // Note: This client won't be returned to the pool as it's used for subscription
    }
}

let redisPool: RedisPool | null = null;
let redisPoolDestroy: (() => Promise<void>) | null = null;

export async function createKVStore(): Promise<KVStore> {
    if (!env.REDIS_URL) {
        throw new Error("REDIS_URL must be set for Redis KV store");
    }
    if (!redisPool) {
        redisPool = new RedisPool(env.REDIS_URL);
        redisPoolDestroy = async () => {
            if (redisPool) {
                await redisPool.destroy();
                redisPool = null;
                redisPoolDestroy = null;
            }
        };
    }
    return new PooledRedisKVStore(redisPool);
}

export async function destroyKVStore(): Promise<void> {
    if (redisPoolDestroy) {
        await redisPoolDestroy();
    }
}

const kv = await createKVStore();
export { kv };
