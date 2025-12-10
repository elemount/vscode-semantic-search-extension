/**
 * Types and interfaces for the Semantic Search extension
 */

/**
 * Represents a workspace in the database
 */
export interface Workspace {
    workspaceId: string;
    workspacePath: string;
    workspaceName: string;
    status: 'active' | 'indexing' | 'error';
    createdAt: number; // Unix timestamp
    lastUpdatedAt: number; // Unix timestamp
    totalFiles: number;
    totalChunks: number;
}

/**
 * Represents an indexed file's metadata stored in DuckDB
 */
export interface IndexedFile {
    fileId: string;
    workspaceId: string;
    filePath: string; // Full relative path, e.g., 'src/components/Button.tsx'
    folderPath: string; // Derived: 'src/components' (for grouping/tree view)
    fileName: string; // Just 'Button.tsx'
    md5Hash: string;
    language?: string;
    fileSize?: number;
    lineCount?: number;
    chunkCount: number;
    createdAt: number; // Unix timestamp
    lastIndexedAt: number; // Unix timestamp
    // Legacy field for backward compatibility
    workspacePath?: string;
}

/**
 * Represents a code chunk stored in the database
 */
export interface CodeChunk {
    chunkId: string;
    fileId: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    chunkIndex: number; // Order within file
    createdAt: number; // Unix timestamp
}

/**
 * Represents a document chunk stored in ChromaDB
 * @deprecated Use CodeChunk instead
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
 * Folder information derived from file paths
 */
export interface FolderInfo {
    folderPath: string;
    fileCount: number;
    totalChunks: number;
}

/**
 * Tree node types for the index browser
 */
export type TreeNodeType = 'workspace' | 'folder' | 'file' | 'chunk';

/**
 * Base tree node for index browser
 */
export interface TreeNode {
    type: TreeNodeType;
    id: string;
    label: string;
    description?: string;
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
    chunkOverlapTokens: 128,
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
