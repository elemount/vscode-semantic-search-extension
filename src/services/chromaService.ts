/**
 * ChromaDB Service for embedding storage and vector search
 * Uses chromadb npm package for Node.js embedded vector database
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentChunk, SearchResult } from '../models/types';
import { ChromaProcessManager, ChromaServerStatus } from './chromaProcessManager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChromaClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Collection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmbeddingFunction = any;

export class ChromaService {
    private client: ChromaClient | null = null;
    private collection: Collection | null = null;
    private embeddingFunction: EmbeddingFunction | null = null;
    private storagePath: string;
    private collectionName: string = 'semantic_search_index';
    private initialized: boolean = false;
    private processManager: ChromaProcessManager | null = null;
    private context: vscode.ExtensionContext | null = null;
    private useServerMode: boolean = false;

    constructor(storagePath: string, context?: vscode.ExtensionContext) {
        this.storagePath = storagePath;
        if (context) {
            this.context = context;
            this.processManager = new ChromaProcessManager(context);
            this.useServerMode = this.shouldUseServerMode();
        }
    }

    /**
     * Check if we should use server mode (bundled Chroma executable exists)
     */
    private shouldUseServerMode(): boolean {
        if (!this.context) {
            return false;
        }

        const platform = process.platform;
        const arch = process.arch;
        const ext = platform === 'win32' ? '.exe' : '';

        let platformDir: string;
        if (platform === 'win32') {
            platformDir = 'win32-x64';
        } else if (platform === 'darwin') {
            platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
        } else {
            platformDir = 'linux-x64';
        }

        const execPath = path.join(
            this.context.extensionPath,
            'bin',
            platformDir,
            `chroma${ext}`
        );

        return fs.existsSync(execPath);
    }

    /**
     * Get server status
     */
    getServerStatus(): ChromaServerStatus {
        return this.processManager?.getStatus() ?? 'stopped';
    }

    /**
     * Subscribe to server status changes
     */
    onServerStatusChange(listener: (status: ChromaServerStatus) => void): vscode.Disposable {
        if (this.processManager) {
            return this.processManager.onStatusChange(listener);
        }
        return { dispose: () => {} };
    }

    /**
     * Initialize ChromaDB client and collection
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Ensure storage directory exists
        const chromaPath = path.join(this.storagePath, 'chroma');
        if (!fs.existsSync(chromaPath)) {
            fs.mkdirSync(chromaPath, { recursive: true });
        }

        // Import chromadb
        const { ChromaClient, DefaultEmbeddingFunction } = require('chromadb');

        // Check if we should use server mode
        if (this.useServerMode && this.processManager) {
            // Start the Chroma server process
            console.log('Starting Chroma server in server mode...');
            await this.processManager.start();

            // Connect client to the server
            this.client = new ChromaClient({
                path: this.processManager.getServerUrl()
            });
            console.log(`Connected to Chroma server at ${this.processManager.getServerUrl()}`);
        } else {
            // Create client - ChromaDB will use an in-memory client by default
            // For persistence, we'll store data manually or use the server mode later
            console.log('Starting Chroma in in-memory mode (server binaries not found)...');
            this.client = new ChromaClient();
        }
        
        // Use the default embedding function (all-MiniLM-L6-v2)
        this.embeddingFunction = new DefaultEmbeddingFunction();

        // Get or create collection with the embedding function
        this.collection = await this.client.getOrCreateCollection({
            name: this.collectionName,
            embeddingFunction: this.embeddingFunction,
            metadata: {
                description: 'VSCode Semantic Search Index',
            },
        });

        this.initialized = true;
    }

    /**
     * Add document chunks to the collection
     */
    async addChunks(chunks: DocumentChunk[]): Promise<void> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        if (chunks.length === 0) {
            return;
        }

        const ids = chunks.map((c) => c.id);
        const documents = chunks.map((c) => c.content);
        const metadatas = chunks.map((c) => ({
            fileId: c.fileId,
            filePath: c.filePath,
            lineStart: c.lineStart,
            lineEnd: c.lineEnd,
            lineRange: `line:${c.lineStart}-line:${c.lineEnd}`,
        }));

        await this.collection.add({
            ids,
            documents,
            metadatas,
        });
    }

    /**
     * Update existing chunks
     */
    async updateChunks(chunks: DocumentChunk[]): Promise<void> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        if (chunks.length === 0) {
            return;
        }

        const ids = chunks.map((c) => c.id);
        const documents = chunks.map((c) => c.content);
        const metadatas = chunks.map((c) => ({
            fileId: c.fileId,
            filePath: c.filePath,
            lineStart: c.lineStart,
            lineEnd: c.lineEnd,
            lineRange: `line:${c.lineStart}-line:${c.lineEnd}`,
        }));

        await this.collection.update({
            ids,
            documents,
            metadatas,
        });
    }

    /**
     * Delete chunks by IDs
     */
    async deleteChunks(ids: string[]): Promise<void> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        if (ids.length === 0) {
            return;
        }

        await this.collection.delete({
            ids,
        });
    }

    /**
     * Delete all chunks for a file
     */
    async deleteFileChunks(fileId: string): Promise<void> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        await this.collection.delete({
            where: {
                fileId: fileId,
            },
        });
    }

    /**
     * Search for similar documents
     */
    async search(query: string, nResults: number = 10): Promise<SearchResult[]> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        const results = await this.collection.query({
            queryTexts: [query],
            nResults,
        });

        if (!results.documents || !results.documents[0]) {
            return [];
        }

        const searchResults: SearchResult[] = [];
        const documents = results.documents[0];
        const metadatas = results.metadatas?.[0] ?? [];
        const distances = results.distances?.[0] ?? [];

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const metadata = metadatas[i] as {
                filePath?: string;
                lineStart?: number;
                lineEnd?: number;
            } | null;
            const distance = distances[i] ?? 0;

            if (doc && metadata) {
                // Convert distance to similarity score (ChromaDB returns L2 distance)
                // Lower distance = more similar, so we invert it
                const score = 1 / (1 + distance);

                searchResults.push({
                    filePath: metadata.filePath ?? '',
                    lineStart: metadata.lineStart ?? 0,
                    lineEnd: metadata.lineEnd ?? 0,
                    content: doc,
                    score,
                });
            }
        }

        return searchResults;
    }

    /**
     * Search within a specific workspace
     */
    async searchInWorkspace(
        query: string,
        workspacePath: string,
        nResults: number = 10
    ): Promise<SearchResult[]> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        // First, get all results then filter by workspace
        // ChromaDB doesn't support complex where clauses with string prefix matching
        const results = await this.collection.query({
            queryTexts: [query],
            nResults: nResults * 3, // Get more results to account for filtering
        });

        if (!results.documents || !results.documents[0]) {
            return [];
        }

        const searchResults: SearchResult[] = [];
        const documents = results.documents[0];
        const metadatas = results.metadatas?.[0] ?? [];
        const distances = results.distances?.[0] ?? [];

        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const metadata = metadatas[i] as {
                filePath?: string;
                lineStart?: number;
                lineEnd?: number;
            } | null;
            const distance = distances[i] ?? 0;

            if (doc && metadata && metadata.filePath) {
                // Filter by workspace path
                if (!metadata.filePath.startsWith(workspacePath)) {
                    continue;
                }

                const score = 1 / (1 + distance);

                searchResults.push({
                    filePath: metadata.filePath,
                    lineStart: metadata.lineStart ?? 0,
                    lineEnd: metadata.lineEnd ?? 0,
                    content: doc,
                    score,
                });

                if (searchResults.length >= nResults) {
                    break;
                }
            }
        }

        return searchResults;
    }

    /**
     * Get chunk count for a file
     */
    async getFileChunkCount(fileId: string): Promise<number> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        const results = await this.collection.get({
            where: {
                fileId: fileId,
            },
        });

        return results.ids?.length ?? 0;
    }

    /**
     * Get total chunk count
     */
    async getTotalChunkCount(): Promise<number> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        const count = await this.collection.count();
        return count;
    }

    /**
     * Check if file is indexed
     */
    async isFileIndexed(fileId: string): Promise<boolean> {
        const count = await this.getFileChunkCount(fileId);
        return count > 0;
    }

    /**
     * Clear all data from the collection
     */
    async clearAll(): Promise<void> {
        if (!this.client) {
            throw new Error('ChromaDB not initialized');
        }

        // Delete and recreate the collection
        await this.client.deleteCollection({ name: this.collectionName });
        this.collection = await this.client.getOrCreateCollection({
            name: this.collectionName,
            metadata: {
                description: 'VSCode Semantic Search Index',
            },
        });
    }

    /**
     * Get all chunk IDs for a file
     */
    async getFileChunkIds(fileId: string): Promise<string[]> {
        if (!this.collection) {
            throw new Error('ChromaDB not initialized');
        }

        const results = await this.collection.get({
            where: {
                fileId: fileId,
            },
        });

        return results.ids ?? [];
    }

    /**
     * Dispose resources and stop the Chroma server
     */
    async dispose(): Promise<void> {
        if (this.processManager) {
            await this.processManager.stop();
            this.processManager.dispose();
        }
        this.initialized = false;
        this.client = null;
        this.collection = null;
    }
}
