/**
 * Web SDK — public barrel export.
 *
 * Consumers import the adapter class that matches their player engine:
 *
 *   // hls.js
 *   import { HlsJsAdapter } from '@analytics/sdk/web';
 *
 *   // dash.js
 *   import { DashJsAdapter } from '@analytics/sdk/web';
 *
 *   // Shaka Player
 *   import { ShakaAdapter } from '@analytics/sdk/web';
 *
 *   // Plain HTML5 / any other engine
 *   import { WebAdapter } from '@analytics/sdk/web';
 */

export { WebAdapter }    from './WebAdapter';
export { HlsJsAdapter }  from './HlsJsAdapter';
export { DashJsAdapter } from './DashJsAdapter';
export { ShakaAdapter }  from './ShakaAdapter';

export type { WebAdapterOptions }    from './WebAdapter';
export type { HlsJsAdapterOptions }  from './HlsJsAdapter';
export type { DashJsAdapterOptions } from './DashJsAdapter';
export type { ShakaAdapterOptions }  from './ShakaAdapter';
