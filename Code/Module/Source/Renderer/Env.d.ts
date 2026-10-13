/// <reference types="vite/client" />
import type { HybridRefApi } from '../Shared/Types'
declare global { interface Window { HybridRef: HybridRefApi } }
