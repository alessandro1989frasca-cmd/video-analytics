/**
 * Smart TV SDK — public barrel export (TypeScript adapters only).
 *
 * Platform selection guide:
 *
 *  Samsung Tizen (AVPlay)         → TizenAdapter
 *  Samsung Tizen (hls.js/Shaka)   → HlsJsAdapter or ShakaAdapter with platform:'tizen'
 *  LG webOS                       → WebOsAdapter
 *  Android TV / Fire TV           → AndroidTvAdapter (sdk/smarttv/AndroidTvAdapter.kt)
 *  Roku                           → RokuAdapter.brs (BrightScript)
 */

export { TizenAdapter }  from './TizenAdapter';
export { WebOsAdapter }  from './WebOsAdapter';

export type { TizenAdapterOptions } from './TizenAdapter';
export type { WebOsAdapterOptions } from './WebOsAdapter';
