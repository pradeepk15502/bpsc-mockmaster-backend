import { Redis } from 'ioredis';
export type { Redis };
export function createRedis(url: string): Redis {
  // maxRetriesPerRequest:null is required by BullMQ workers.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}
