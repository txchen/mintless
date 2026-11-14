import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './http/auth-routes.ts';
import type { AppDeps, AppEnv } from './http/context.ts';
import { adminRoutes, appRoutes } from './http/routes.ts';

export function createApi(deps: AppDeps) {
  return new Hono<AppEnv>()
    .basePath('/api')
    .use(secureHeaders({ crossOriginResourcePolicy: 'same-origin' }))
    .use(async (c, next) => {
      c.set('deps', deps);
      c.header('cache-control', 'no-store');
      await next();
    })
    .get('/health', (c) => c.json({ ok: true }))
    .route('/', authRoutes)
    .route('/admin', adminRoutes)
    .route('/', appRoutes)
    .notFound((c) => c.json({ error: 'not_found' }, 404))
    .onError((error, c) => {
      if (error instanceof HTTPException) return error.getResponse();
      console.error('request failed', c.req.method, c.req.path, error);
      return c.json({ error: 'internal' }, 500);
    });
}
