/**
 * Vector Database Service - Uses DuckDB with VSS extension
 * Combines vector storage and metadata in a single database
 */

import * as path from 'path';
import * as fs from 'fs';
import { EmbeddingService } from './embeddingService';
import { IndexedFile, SearchResult } from '../models/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DuckDBInstance: any;

interface CodeChunk {
    chunkId: string;
    fileId: string;
    filePath: string;
    workspacePath: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    language?: string;
}

export class VectorDbService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private instance: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private connection: any = null;
    private storagePath: string;
    private dbPath: string;
    private initialized: boolean = false;
    private dimensions: number;
    
    constructor(
        storagePath: string,
        private embeddingService: EmbeddingService
    ) {
        this.storagePath = storagePath;
        this.dbPath = path.join(storagePath, 'semanticsearch.duckdb');
        this.dimensions = embeddingService.getDimensions();
    }
    
    /**
     * Initialize DuckDB with VSS extension
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        
        // Ensure storage directory exists
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
        
        // Dynamically import @duckdb/node-api
        const duckdb = require('@duckdb/node-api');
        DuckDBInstance = duckdb.DuckDBInstance;
        
        // Create instance and connection
        this.instance = await DuckDBInstance.create(this.dbPath);
        this.connection = await this.instance.connect();
        
        // Install and load VSS extension
        await this.connection.run('INSTALL vss');
        await this.connection.run('LOAD vss');
        await this.connection.run('SET hnsw_enable_experimental_persistence = true');
        
        // Create schema
        await this.createSchema();
        
        this.initialized = true;
    }
    
    /**
     * Create database schema
     */
    private async createSchema(): Promise<void> {
        // Create indexed_files table
        await this.connection.run(`
            CREATE TABLE IF NOT EXISTS indexed_files (
                file_id VARCHAR PRIMARY KEY,
                file_path VARCHAR NOT NULL,
                workspace_path VARCHAR NOT NULL,
                md5_hash VARCHAR NOT NULL,
                last_indexed_at BIGINT NOT NULL
            )
        `);
        
        // Create indexes for indexed_files
        await this.connection.run(`
            CREATE INDEX IF NOT EXISTS idx_workspace_path ON indexed_files(workspace_path)
        `);
        await this.connection.run(`
            CREATE INDEX IF NOT EXISTS idx_file_path ON indexed_files(file_path)
        `);
        
        // Create code_chunks table with embedding column
        await this.connection.run(`
            CREATE TABLE IF NOT EXISTS code_chunks (
                chunk_id VARCHAR PRIMARY KEY,
                file_id VARCHAR NOT NULL,
                file_path VARCHAR NOT NULL,
                workspace_path VARCHAR NOT NULL,
                content TEXT NOT NULL,
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                language VARCHAR,
                embedding FLOAT[${this.dimensions}],
                created_at BIGINT NOT NULL
            )
        `);
        
        // Create regular indexes for filtering
        await this.connection.run(`
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_id)
        `);
        await this.connection.run(`
            CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON code_chunks(workspace_path)
        `);
        
        // Create HNSW index for vector search
        // Note: This may fail if index already exists, which is fine
        try {
            await this.connection.run(`
                CREATE INDEX idx_chunks_embedding 
                ON code_chunks 
                USING HNSW (embedding)
                WITH (metric = 'cosine')
            `);
        } catch {
            // Index may already exist
        }
    }
    
    /**
     * Run SQL statement
     */
    private async runSQL(sql: string): Promise<void> {
        if (!this.connection) {
            throw new Error('Database not initialized');
        }
        await this.connection.run(sql);
    }
    
    /**
     * Query and return results
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async querySQL<T>(sql: string, ...params: unknown[]): Promise<T[]> {
        if (!this.connection) {
            throw new Error('Database not initialized');
        }

        // Prepare statement if we have parameters
        if (params.length > 0) {
            const stmt = await this.connection.prepare(sql);
            for (let i = 0; i < params.length; i++) {
                stmt.bindValue(i + 1, params[i]);
            }
            const result = await stmt.run();
            const rows = await result.getRows();
            return this.convertRows<T>(rows, result);
        }

        const result = await this.connection.run(sql);
        const rows = await result.getRows();
        return this.convertRows<T>(rows, result);
    }
    
    /**
     * Convert DuckDB rows to objects
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private convertRows<T>(rows: any[], result: any): T[] {
        if (!rows || rows.length === 0) {
            return [];
        }

        const columnNames = result.columnNames();
        return rows.map(row => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const obj: any = {};
            for (let i = 0; i < columnNames.length; i++) {
                obj[columnNames[i]] = row[i];
            }
            return obj as T;
        });
    }
    
    /**
     * Add a code chunk with its embedding
     */
    async addChunk(chunk: CodeChunk): Promise<void> {
        // Generate embedding
        const embedding = await this.embeddingService.embed(chunk.content);
        
        // Format embedding as DuckDB array literal
        const embeddingStr = `[${embedding.join(',')}]::FLOAT[${this.dimensions}]`;
        
        // Escape content for SQL
        const escapedContent = chunk.content.replace(/'/g, "''");
        const escapedFilePath = chunk.filePath.replace(/'/g, "''");
        const escapedWorkspacePath = chunk.workspacePath.replace(/'/g, "''");
        
        const sql = `
            INSERT INTO code_chunks 
            (chunk_id, file_id, file_path, workspace_path, content, 
             line_start, line_end, language, embedding, created_at)
            VALUES ('${chunk.chunkId}', '${chunk.fileId}', '${escapedFilePath}', 
                    '${escapedWorkspacePath}', '${escapedContent}', 
                    ${chunk.lineStart}, ${chunk.lineEnd}, 
                    ${chunk.language ? `'${chunk.language}'` : 'NULL'}, 
                    ${embeddingStr}, ${Date.now()})
            ON CONFLICT (chunk_id) DO UPDATE SET
                content = excluded.content,
                line_start = excluded.line_start,
                line_end = excluded.line_end,
                embedding = excluded.embedding,
                created_at = excluded.created_at
        `;
        
        await this.connection.run(sql);
    }
    
    /**
     * Add multiple code chunks (batch operation)
     */
    async addChunks(chunks: CodeChunk[]): Promise<void> {
        for (const chunk of chunks) {
            await this.addChunk(chunk);
        }
    }
    
    /**
     * Search for similar code chunks
     */
    async search(
        query: string,
        workspacePath?: string,
        limit: number = 10
    ): Promise<SearchResult[]> {
        // Generate query embedding
        const queryEmbedding = await this.embeddingService.embed(query);
        const embeddingStr = `[${queryEmbedding.join(',')}]::FLOAT[${this.dimensions}]`;
        
        let sql = `
            SELECT 
                chunk_id,
                file_path,
                content,
                line_start,
                line_end,
                array_cosine_distance(embedding, ${embeddingStr}) AS distance
            FROM code_chunks
        `;
        
        if (workspacePath) {
            sql += ` WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'`;
        }
        
        sql += `
            ORDER BY array_cosine_distance(embedding, ${embeddingStr})
            LIMIT ${limit}
        `;
        
        const result = await this.connection.run(sql);
        const rows = await result.getRows();
        const columnNames = result.columnNames();
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return rows.map((row: any[]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const obj: any = {};
            columnNames.forEach((col: string, i: number) => {
                obj[col] = row[i];
            });
            return {
                filePath: obj.file_path,
                content: obj.content,
                lineStart: obj.line_start,
                lineEnd: obj.line_end,
                score: 1 - obj.distance  // Convert distance to similarity score
            };
        });
    }
    
    /**
     * Delete all chunks for a file
     */
    async deleteFileChunks(fileId: string): Promise<void> {
        await this.connection.run(
            `DELETE FROM code_chunks WHERE file_id = '${fileId.replace(/'/g, "''")}'`
        );
    }
    
    /**
     * Get chunk count for a file
     */
    async getFileChunkCount(fileId: string): Promise<number> {
        const sql = `SELECT COUNT(*) as count FROM code_chunks WHERE file_id = $1`;
        const rows = await this.querySQL<{ count: number }>(sql, fileId);
        return rows[0]?.count ?? 0;
    }
    
    /**
     * Get total chunk count
     */
    async getTotalChunkCount(): Promise<number> {
        const sql = `SELECT COUNT(*) as count FROM code_chunks`;
        const rows = await this.querySQL<{ count: number }>(sql);
        return rows[0]?.count ?? 0;
    }
    
    /**
     * Check if file is indexed
     */
    async isFileIndexed(fileId: string): Promise<boolean> {
        const count = await this.getFileChunkCount(fileId);
        return count > 0;
    }
    
    /**
     * Clear all chunks data
     */
    async clearAllChunks(): Promise<void> {
        await this.runSQL('DELETE FROM code_chunks');
    }
    
    // =====================
    // Indexed Files Methods
    // =====================
    
    /**
     * Add or update an indexed file record
     */
    async upsertIndexedFile(file: IndexedFile): Promise<void> {
        if (!this.connection) {
            throw new Error('Database not initialized');
        }

        const sql = `
            INSERT INTO indexed_files (file_id, file_path, workspace_path, md5_hash, last_indexed_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (file_id) DO UPDATE SET
                file_path = excluded.file_path,
                workspace_path = excluded.workspace_path,
                md5_hash = excluded.md5_hash,
                last_indexed_at = excluded.last_indexed_at
        `;

        const stmt = await this.connection.prepare(sql);
        stmt.bindValue(1, file.fileId);
        stmt.bindValue(2, file.filePath);
        stmt.bindValue(3, file.workspacePath);
        stmt.bindValue(4, file.md5Hash);
        stmt.bindValue(5, file.lastIndexedAt);
        await stmt.run();
    }

    /**
     * Get indexed file by file ID
     */
    async getIndexedFile(fileId: string): Promise<IndexedFile | null> {
        const sql = `SELECT * FROM indexed_files WHERE file_id = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            file_path: string;
            workspace_path: string;
            md5_hash: string;
            last_indexed_at: number;
        }>(sql, fileId);

        if (rows.length === 0) {
            return null;
        }

        const row = rows[0];
        return {
            fileId: row.file_id,
            filePath: row.file_path,
            workspacePath: row.workspace_path,
            md5Hash: row.md5_hash,
            lastIndexedAt: row.last_indexed_at,
        };
    }

    /**
     * Get indexed file by file path
     */
    async getIndexedFileByPath(filePath: string): Promise<IndexedFile | null> {
        const sql = `SELECT * FROM indexed_files WHERE file_path = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            file_path: string;
            workspace_path: string;
            md5_hash: string;
            last_indexed_at: number;
        }>(sql, filePath);

        if (rows.length === 0) {
            return null;
        }

        const row = rows[0];
        return {
            fileId: row.file_id,
            filePath: row.file_path,
            workspacePath: row.workspace_path,
            md5Hash: row.md5_hash,
            lastIndexedAt: row.last_indexed_at,
        };
    }

    /**
     * Get all indexed files for a workspace
     */
    async getIndexedFilesForWorkspace(workspacePath: string): Promise<IndexedFile[]> {
        const sql = `SELECT * FROM indexed_files WHERE workspace_path = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            file_path: string;
            workspace_path: string;
            md5_hash: string;
            last_indexed_at: number;
        }>(sql, workspacePath);

        return rows.map((row) => ({
            fileId: row.file_id,
            filePath: row.file_path,
            workspacePath: row.workspace_path,
            md5Hash: row.md5_hash,
            lastIndexedAt: row.last_indexed_at,
        }));
    }

    /**
     * Get all indexed files
     */
    async getAllIndexedFiles(): Promise<IndexedFile[]> {
        const sql = `SELECT * FROM indexed_files`;
        const rows = await this.querySQL<{
            file_id: string;
            file_path: string;
            workspace_path: string;
            md5_hash: string;
            last_indexed_at: number;
        }>(sql);

        return rows.map((row) => ({
            fileId: row.file_id,
            filePath: row.file_path,
            workspacePath: row.workspace_path,
            md5Hash: row.md5_hash,
            lastIndexedAt: row.last_indexed_at,
        }));
    }

    /**
     * Delete indexed file by file ID
     */
    async deleteIndexedFile(fileId: string): Promise<void> {
        if (!this.connection) {
            throw new Error('Database not initialized');
        }

        const sql = `DELETE FROM indexed_files WHERE file_id = $1`;
        const stmt = await this.connection.prepare(sql);
        stmt.bindValue(1, fileId);
        await stmt.run();
    }

    /**
     * Delete all indexed files for a workspace
     */
    async deleteWorkspaceIndex(workspacePath: string): Promise<void> {
        if (!this.connection) {
            throw new Error('Database not initialized');
        }

        // Delete all chunks for workspace
        await this.connection.run(
            `DELETE FROM code_chunks WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'`
        );
        
        // Delete indexed file records
        const sql = `DELETE FROM indexed_files WHERE workspace_path = $1`;
        const stmt = await this.connection.prepare(sql);
        stmt.bindValue(1, workspacePath);
        await stmt.run();
    }

    /**
     * Get count of indexed files for a workspace
     */
    async getIndexedFileCount(workspacePath?: string): Promise<number> {
        let sql = `SELECT COUNT(*) as count FROM indexed_files`;
        const params: unknown[] = [];
        
        if (workspacePath) {
            sql += ` WHERE workspace_path = $1`;
            params.push(workspacePath);
        }

        const rows = await this.querySQL<{ count: number }>(sql, ...params);
        return rows[0]?.count ?? 0;
    }
    
    /**
     * Compact the HNSW index (removes deleted entries)
     */
    async compactIndex(): Promise<void> {
        try {
            await this.connection.run(`PRAGMA hnsw_compact_index('idx_chunks_embedding')`);
        } catch {
            // Index might not exist yet
        }
    }
    
    /**
     * Close database connection
     */
    async close(): Promise<void> {
        if (this.connection) {
            this.connection.closeSync();
            this.connection = null;
        }
        if (this.instance) {
            this.instance.closeSync();
            this.instance = null;
        }
        this.initialized = false;
    }
}
