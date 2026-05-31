import IORedis, { type Redis, type RedisOptions } from 'ioredis';

declare global {
  // eslint-disable-next-line no-var
  var __angoconnect_redis__: Redis | undefined;
}

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

function buildConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not defined');
  }
  return new IORedis(url, redisOptions);
}

export const redisConnection: Redis =
  global.__angoconnect_redis__ ?? buildConnection();

if (process.env.NODE_ENV !== 'production') {
  global.__angoconnect_redis__ = redisConnection;
}
