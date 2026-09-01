/**
 * Request ID middleware — adds a unique X-Request-ID header to every response.
 * Used for tracing individual ingestion requests through logs.
 */

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { v4 as uuidv4 } from 'uuid';

const requestIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const id = (request.headers['x-request-id'] as string) ?? uuidv4();
    request.id = id;
    reply.header('X-Request-ID', id);
  });
};

// Note: fastify-plugin is used so the hook is not scoped to a child context.
// If fastify-plugin is not available, register the hook directly on root fastify.
export default requestIdPlugin;
