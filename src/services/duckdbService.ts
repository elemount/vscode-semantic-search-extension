/**
 * DuckDB Service for metadata persistence
 * Using @duckdb/node-api
 */

import * as path from 'path';
import * as fs from 'fs';
import { IndexedFile } from '../models/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DuckDBInstance: any;

export class DuckDBService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private instance: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private connection: any = null;
    private storagePath: string;
    private dbPath: string;
    private initialized: boolean = false;

    constructor(storagePath: string) {
        this.storagePath = storagePath;
        this.dbPath = path.join(storagePath, 'metadata.duckdb');
    }

    /**
     * Initialize DuckDB connection and create tables
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

        await this.createTables();
        this.initialized = true;
    }

    /**
     * Create necessary tables
     */
    private async createTables(): Promise<void> {
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS indexed_files (
                file_id VARCHAR PRIMARY KEY,
                file_path VARCHAR NOT NULL,
                workspace_path VARCHAR NOT NULL,
                md5_hash VARCHAR NOT NULL,
                last_indexed_at BIGINT NOT NULL
            );
        `;

        await this.runSQL(createTableSQL);

        // Create indexes separately
        await this.runSQL(`CREATE INDEX IF NOT EXISTS idx_workspace_path ON indexed_files(workspace_path);`);
        await this.runSQL(`CREATE INDEX IF NOT EXISTS idx_file_path ON indexed_files(file_path);`);
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
        let params: unknown[] = [];
        
        if (workspacePath) {
            sql += ` WHERE workspace_path = $1`;
            params = [workspacePath];
        }

        const rows = await this.querySQL<{ count: number }>(sql, ...params);
        return rows[0]?.count ?? 0;
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
