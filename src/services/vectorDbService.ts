/**
 * Vector Database Service - Uses DuckDB with VSS extension
 * Combines vector storage and metadata in a single database
 */

import * as path from 'path';
import * as fs from 'fs';
import { EmbeddingService } from './embeddingService';
import { IndexedFile, SearchResult, Workspace, FolderInfo, CodeChunk } from '../models/types';
import { MigrationService } from './migrationService';
import { getLogger } from './logger';

 
let DuckDBInstance: any;

interface CodeChunkInput {
    chunkId: string;
    fileId: string;
    filePath: string;
    workspacePath: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    chunkIndex?: number;
    language?: string;
}

export class VectorDbService {
     
    private instance: any = null;
     
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
        
        const logger = getLogger();
        
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
        
        // Run migrations to ensure schema is up to date
        const migrationService = new MigrationService(this.connection, this.dimensions);
        if (await migrationService.needsMigration()) {
            logger.info('VectorDbService', 'Running database migrations...');
            await migrationService.migrate();
            logger.info('VectorDbService', 'Database migrations completed');
        }
        
        // Create HNSW index if not exists
        await this.createHnswIndex();
        
        this.initialized = true;
    }
    
    /**
     * Create HNSW index for vector search
     */
    private async createHnswIndex(): Promise<void> {
        try {
            await this.connection.run(`
                CREATE INDEX IF NOT EXISTS idx_chunks_embedding 
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
     
    private convertRows<T>(rows: any[], result: any): T[] {
        if (!rows || rows.length === 0) {
            return [];
        }

        const columnNames = result.columnNames();
        return rows.map(row => {
             
            const obj: any = {};
            for (let i = 0; i < columnNames.length; i++) {
                // Convert BigInt to Number for JavaScript compatibility
                const value = row[i];
                obj[columnNames[i]] = typeof value === 'bigint' ? Number(value) : value;
            }
            return obj as T;
        });
    }
    
    /**
     * Add a code chunk with its embedding
     */
    async addChunk(chunk: CodeChunkInput): Promise<void> {
        // Generate embedding using document task format
        const embedding = await this.embeddingService.embedDocument(chunk.content, chunk.filePath);
        
        // Format embedding as DuckDB array literal
        const embeddingStr = `[${embedding.join(',')}]::FLOAT[${this.dimensions}]`;
        
        // Escape content for SQL
        const escapedContent = chunk.content.replace(/'/g, "''");
        const escapedFilePath = chunk.filePath.replace(/'/g, "''");
        const escapedWorkspacePath = chunk.workspacePath.replace(/'/g, "''");
        const chunkIndex = chunk.chunkIndex ?? 0;
        
        const sql = `
            INSERT INTO code_chunks 
            (chunk_id, file_id, file_path, workspace_path, content, 
             line_start, line_end, chunk_index, token_start, token_end, language, embedding, created_at)
            VALUES ('${chunk.chunkId}', '${chunk.fileId}', '${escapedFilePath}', 
                    '${escapedWorkspacePath}', '${escapedContent}', 
                    ${chunk.lineStart}, ${chunk.lineEnd}, ${chunkIndex},
                    NULL, NULL,
                    ${chunk.language ? `'${chunk.language}'` : 'NULL'}, 
                    ${embeddingStr}, ${Date.now()})
            ON CONFLICT (chunk_id) DO UPDATE SET
                content = excluded.content,
                line_start = excluded.line_start,
                line_end = excluded.line_end,
                chunk_index = excluded.chunk_index,
                token_start = excluded.token_start,
                token_end = excluded.token_end,
                embedding = excluded.embedding,
                created_at = excluded.created_at
        `;
        
        await this.connection.run(sql);
    }
    
    /**
     * Add multiple code chunks (batch operation)
     */
    async addChunks(chunks: CodeChunkInput[]): Promise<void> {
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
        // Generate query embedding using query task format
        const queryEmbedding = await this.embeddingService.embedQuery(query);
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
        
         
        return rows.map((row: any[]) => {
             
            const obj: any = {};
            columnNames.forEach((col: string, i: number) => {
                // Convert BigInt to Number if necessary
                const value = row[i];
                obj[col] = typeof value === 'bigint' ? Number(value) : value;
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

        // Extract folder_path and file_name from file_path
        const folderPath = file.folderPath || this.extractFolderPath(file.filePath);
        const fileName = file.fileName || this.extractFileName(file.filePath);
        const workspaceId = file.workspaceId || await this.getOrCreateWorkspaceId(file.workspacePath || '');
        const createdAt = file.createdAt || Date.now();
        
        const sql = `
            INSERT INTO indexed_files (file_id, workspace_id, file_path, folder_path, file_name, 
                                       workspace_path, md5_hash, language, file_size, line_count, 
                                       chunk_count, created_at, last_indexed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (file_id) DO UPDATE SET
                file_path = excluded.file_path,
                folder_path = excluded.folder_path,
                file_name = excluded.file_name,
                workspace_path = excluded.workspace_path,
                md5_hash = excluded.md5_hash,
                language = excluded.language,
                file_size = excluded.file_size,
                line_count = excluded.line_count,
                chunk_count = excluded.chunk_count,
                last_indexed_at = excluded.last_indexed_at
        `;

        const stmt = await this.connection.prepare(sql);
        stmt.bindValue(1, file.fileId);
        stmt.bindValue(2, workspaceId);
        stmt.bindValue(3, file.filePath);
        stmt.bindValue(4, folderPath);
        stmt.bindValue(5, fileName);
        stmt.bindValue(6, file.workspacePath || '');
        stmt.bindValue(7, file.md5Hash);
        stmt.bindValue(8, file.language || null);
        stmt.bindValue(9, file.fileSize || null);
        stmt.bindValue(10, file.lineCount || null);
        stmt.bindValue(11, file.chunkCount || 0);
        stmt.bindValue(12, createdAt);
        stmt.bindValue(13, file.lastIndexedAt);
        await stmt.run();
    }

    /**
     * Extract folder path from full file path
     */
    private extractFolderPath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        return lastSlash > 0 ? normalized.substring(0, lastSlash) : '';
    }

    /**
     * Extract file name from full file path
     */
    private extractFileName(filePath: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        const lastSlash = normalized.lastIndexOf('/');
        return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
    }

    /**
     * Get or create workspace ID from workspace path
     */
    private async getOrCreateWorkspaceId(workspacePath: string): Promise<string> {
        if (!workspacePath) {
            return '';
        }
        
        // Check if workspace exists
        const existingWorkspace = await this.getWorkspaceByPath(workspacePath);
        if (existingWorkspace) {
            return existingWorkspace.workspaceId;
        }

        // Create new workspace
        const crypto = require('crypto');
        const workspaceId = crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 16);
        const workspaceName = workspacePath.split(/[/\\]/).pop() || workspacePath;
        
        await this.connection.run(`
            INSERT INTO workspaces (workspace_id, workspace_path, workspace_name, status, created_at, last_updated_at, total_files, total_chunks)
            VALUES ('${workspaceId}', '${workspacePath.replace(/'/g, "''")}', '${workspaceName.replace(/'/g, "''")}', 'active', ${Date.now()}, ${Date.now()}, 0, 0)
            ON CONFLICT (workspace_id) DO NOTHING
        `);

        return workspaceId;
    }

    /**
     * Get indexed file by file ID
     */
    async getIndexedFile(fileId: string): Promise<IndexedFile | null> {
        const sql = `SELECT * FROM indexed_files WHERE file_id = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            workspace_id: string;
            file_path: string;
            folder_path: string;
            file_name: string;
            workspace_path: string;
            md5_hash: string;
            language: string | null;
            file_size: number | null;
            line_count: number | null;
            chunk_count: number;
            created_at: number;
            last_indexed_at: number;
        }>(sql, fileId);

        if (rows.length === 0) {
            return null;
        }

        return this.mapRowToIndexedFile(rows[0]);
    }

    /**
     * Get indexed file by file path
     */
    async getIndexedFileByPath(filePath: string): Promise<IndexedFile | null> {
        const sql = `SELECT * FROM indexed_files WHERE file_path = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            workspace_id: string;
            file_path: string;
            folder_path: string;
            file_name: string;
            workspace_path: string;
            md5_hash: string;
            language: string | null;
            file_size: number | null;
            line_count: number | null;
            chunk_count: number;
            created_at: number;
            last_indexed_at: number;
        }>(sql, filePath);

        if (rows.length === 0) {
            return null;
        }

        return this.mapRowToIndexedFile(rows[0]);
    }

    /**
     * Map database row to IndexedFile interface
     */
    private mapRowToIndexedFile(row: {
        file_id: string;
        workspace_id?: string;
        file_path: string;
        folder_path?: string;
        file_name?: string;
        workspace_path: string;
        md5_hash: string;
        language?: string | null;
        file_size?: number | null;
        line_count?: number | null;
        chunk_count?: number;
        created_at?: number;
        last_indexed_at: number;
    }): IndexedFile {
        return {
            fileId: row.file_id,
            workspaceId: row.workspace_id || '',
            filePath: row.file_path,
            folderPath: row.folder_path || this.extractFolderPath(row.file_path),
            fileName: row.file_name || this.extractFileName(row.file_path),
            md5Hash: row.md5_hash,
            language: row.language || undefined,
            fileSize: row.file_size || undefined,
            lineCount: row.line_count || undefined,
            chunkCount: row.chunk_count || 0,
            createdAt: row.created_at || row.last_indexed_at,
            lastIndexedAt: row.last_indexed_at,
            workspacePath: row.workspace_path,
        };
    }

    /**
     * Get all indexed files for a workspace
     */
    async getIndexedFilesForWorkspace(workspacePath: string): Promise<IndexedFile[]> {
        const sql = `SELECT * FROM indexed_files WHERE workspace_path = $1`;
        const rows = await this.querySQL<{
            file_id: string;
            workspace_id: string;
            file_path: string;
            folder_path: string;
            file_name: string;
            workspace_path: string;
            md5_hash: string;
            language: string | null;
            file_size: number | null;
            line_count: number | null;
            chunk_count: number;
            created_at: number;
            last_indexed_at: number;
        }>(sql, workspacePath);

        return rows.map((row) => this.mapRowToIndexedFile(row));
    }

    /**
     * Get all indexed files
     */
    async getAllIndexedFiles(): Promise<IndexedFile[]> {
        const sql = `SELECT * FROM indexed_files`;
        const rows = await this.querySQL<{
            file_id: string;
            workspace_id: string;
            file_path: string;
            folder_path: string;
            file_name: string;
            workspace_path: string;
            md5_hash: string;
            language: string | null;
            file_size: number | null;
            line_count: number | null;
            chunk_count: number;
            created_at: number;
            last_indexed_at: number;
        }>(sql);

        return rows.map((row) => this.mapRowToIndexedFile(row));
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

    // =====================
    // Workspace Methods
    // =====================

    /**
     * Get workspace by path
     */
    async getWorkspaceByPath(workspacePath: string): Promise<Workspace | null> {
        try {
            const sql = `SELECT * FROM workspaces WHERE workspace_path = $1`;
            const rows = await this.querySQL<{
                workspace_id: string;
                workspace_path: string;
                workspace_name: string;
                status: string;
                created_at: number;
                last_updated_at: number;
                total_files: number;
                total_chunks: number;
            }>(sql, workspacePath);

            if (rows.length === 0) {
                return null;
            }

            const row = rows[0];
            return {
                workspaceId: row.workspace_id,
                workspacePath: row.workspace_path,
                workspaceName: row.workspace_name,
                status: row.status as 'active' | 'indexing' | 'error',
                createdAt: row.created_at,
                lastUpdatedAt: row.last_updated_at,
                totalFiles: row.total_files,
                totalChunks: row.total_chunks,
            };
        } catch {
            // Workspaces table may not exist in older databases
            return null;
        }
    }

    /**
     * Get all workspaces
     */
    async getAllWorkspaces(): Promise<Workspace[]> {
        try {
            const sql = `SELECT * FROM workspaces ORDER BY workspace_name`;
            const rows = await this.querySQL<{
                workspace_id: string;
                workspace_path: string;
                workspace_name: string;
                status: string;
                created_at: number;
                last_updated_at: number;
                total_files: number;
                total_chunks: number;
            }>(sql);

            return rows.map((row) => ({
                workspaceId: row.workspace_id,
                workspacePath: row.workspace_path,
                workspaceName: row.workspace_name,
                status: row.status as 'active' | 'indexing' | 'error',
                createdAt: row.created_at,
                lastUpdatedAt: row.last_updated_at,
                totalFiles: row.total_files,
                totalChunks: row.total_chunks,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Update workspace statistics
     */
    async updateWorkspaceStats(workspacePath: string): Promise<void> {
        try {
            const fileCount = await this.getIndexedFileCount(workspacePath);
            const chunkCount = await this.getTotalChunkCountForWorkspace(workspacePath);
            
            await this.connection.run(`
                UPDATE workspaces 
                SET total_files = ${fileCount}, 
                    total_chunks = ${chunkCount}, 
                    last_updated_at = ${Date.now()}
                WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'
            `);
        } catch {
            // Workspaces table may not exist
        }
    }

    /**
     * Get total chunk count for a workspace
     */
    async getTotalChunkCountForWorkspace(workspacePath: string): Promise<number> {
        const sql = `SELECT COUNT(*) as count FROM code_chunks WHERE workspace_path = $1`;
        const rows = await this.querySQL<{ count: number }>(sql, workspacePath);
        return rows[0]?.count ?? 0;
    }

    // =====================
    // Folder Methods
    // =====================

    /**
     * Get folder hierarchy with file counts for a workspace
     */
    async getFolderHierarchy(workspacePath: string): Promise<FolderInfo[]> {
        const sql = `
            SELECT 
                folder_path,
                COUNT(*) as file_count,
                SUM(COALESCE(chunk_count, 0)) as total_chunks
            FROM indexed_files
            WHERE workspace_path = $1
            GROUP BY folder_path
            ORDER BY folder_path
        `;
        
        const rows = await this.querySQL<{
            folder_path: string;
            file_count: number;
            total_chunks: number;
        }>(sql, workspacePath);

        return rows.map((row) => ({
            folderPath: row.folder_path || '',
            fileCount: row.file_count,
            totalChunks: row.total_chunks || 0,
        }));
    }

    /**
     * Get files in a specific folder
     */
    async getFilesInFolder(workspacePath: string, folderPath: string): Promise<IndexedFile[]> {
        const sql = `
            SELECT * FROM indexed_files 
            WHERE workspace_path = $1 AND folder_path = $2
            ORDER BY file_name
        `;
        
        const rows = await this.querySQL<{
            file_id: string;
            workspace_id: string;
            file_path: string;
            folder_path: string;
            file_name: string;
            workspace_path: string;
            md5_hash: string;
            language: string | null;
            file_size: number | null;
            line_count: number | null;
            chunk_count: number;
            created_at: number;
            last_indexed_at: number;
        }>(sql, workspacePath, folderPath);

        return rows.map((row) => this.mapRowToIndexedFile(row));
    }

    // =====================
    // Chunk Methods for Tree View
    // =====================

    /**
     * Get chunks for a file
     */
    async getChunksForFile(fileId: string): Promise<CodeChunk[]> {
        const sql = `
            SELECT chunk_id, file_id, content, line_start, line_end, 
                   COALESCE(chunk_index, 0) as chunk_index, created_at
            FROM code_chunks 
            WHERE file_id = $1
            ORDER BY chunk_index, line_start
        `;
        
        const rows = await this.querySQL<{
            chunk_id: string;
            file_id: string;
            content: string;
            line_start: number;
            line_end: number;
            chunk_index: number;
            created_at: number;
        }>(sql, fileId);

        return rows.map((row) => ({
            chunkId: row.chunk_id,
            fileId: row.file_id,
            content: row.content,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            chunkIndex: row.chunk_index,
            createdAt: row.created_at,
        }));
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
