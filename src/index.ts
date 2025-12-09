/**
 * Main exports for the Semantic Search extension
 */

// Models
export * from './models/types';

// Services
export { EmbeddingService } from './services/embeddingService';
export { VectorDbService } from './services/vectorDbService';
export { IndexingService } from './services/indexingService';
export { SearchService } from './services/searchService';

// Utils
export * from './utils/fileUtils';