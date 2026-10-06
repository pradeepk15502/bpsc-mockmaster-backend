import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from './lib/errors.js';
import type { Actor } from './lib/audit.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('VALIDATION_FAILED', 'Some fields are missing or invalid.', { fields });
  }
  return r.data;
}

export interface StudentAuth { kind: 'STUDENT'; sessionId: string; userId: string; name: string; csrf: string }
export interface AdminAuth { kind: 'ADMIN'; sessionId: string; adminId: string; name: string; role: string; csrf: string }
declare module 'fastify' {
  interface FastifyRequest { student?: StudentAuth; admin?: AdminAuth }
}
export const studentOf = (req: FastifyRequest) => req.student!;
export const adminOf = (req: FastifyRequest) => req.admin!;
export function actorOf(req: FastifyRequest): Actor {
  if (req.admin) return { type: 'ADMIN', id: req.admin.adminId, name: req.admin.name, role: req.admin.role, ip: req.ip, requestId: req.id };
  if (req.student) return { type: 'STUDENT', id: req.student.userId, name: req.student.name, role: 'STUDENT', ip: req.ip, requestId: req.id };
  return { type: 'SYSTEM', ip: req.ip, requestId: req.id };
}
export const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');
export const Uuid = z.string().uuid();
