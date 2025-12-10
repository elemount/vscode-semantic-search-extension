/**
 * Types and interfaces for the Semantic Search extension
 */

/**
 * Represents an indexed file's metadata stored in DuckDB
 */
export interface IndexedFile {
    fileId: string;
    filePath: string;
    workspacePath: string;
    md5Hash: string;
    lastIndexedAt: number; // Unix timestamp
}

/**
 * Represents a document chunk stored in ChromaDB
 */
export interface DocumentChunk {
    id: string;
    fileId: string;
    filePath: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    metadata?: Record<string, unknown>;
}

/**
 * Search result returned from semantic search
 */
export interface SearchResult {
    filePath: string;
    lineStart: number;
    lineEnd: number;
    content: string;
    score: number;
}

/**
 * Configuration for indexing
 */
export interface IndexingConfig {
    chunkMaxTokens: number;      // Maximum number of tokens per chunk
    chunkMaxLine: number;        // Maximum number of lines per chunk
    chunkOverlapTokens: number;  // Number of overlapping tokens between chunks
    excludePatterns: string[];
    includePatterns: string[];
}

/**
 * Status of the indexing process
 */
export interface IndexingStatus {
    isIndexing: boolean;
    totalFiles: number;
    processedFiles: number;
    currentFile?: string;
}

/**
 * Index entry for the sidebar view
 */
export interface IndexEntry {
    fileId: string;
    filePath: string;
    relativePath: string;
    isStale: boolean;
    lastIndexedAt: Date;
    chunkCount: number;
}

/**
 * Workspace index information
 */
export interface WorkspaceIndex {
    workspacePath: string;
    totalFiles: number;
    totalChunks: number;
    lastUpdated: Date;
}

/**
 * Default indexing configuration
 */
export const DEFAULT_INDEXING_CONFIG: IndexingConfig = {
    chunkMaxTokens: 1024,
    chunkMaxLine: 40,
    chunkOverlapTokens: 256,
    excludePatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/out/**',
        '**/*.min.js',
        '**/*.map',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/.vscode/**',
        '**/bin/**',
        '**/obj/**',
    ],
    includePatterns: [
        '**/*.ts',
        '**/*.js',
        '**/*.tsx',
        '**/*.jsx',
        '**/*.py',
        '**/*.java',
        '**/*.cs',
        '**/*.go',
        '**/*.rs',
        '**/*.cpp',
        '**/*.c',
        '**/*.h',
        '**/*.hpp',
        '**/*.md',
        '**/*.json',
        '**/*.yaml',
        '**/*.yml',
        '**/*.xml',
        '**/*.html',
        '**/*.css',
        '**/*.scss',
        '**/*.less',
    ],
};
