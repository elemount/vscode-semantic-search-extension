/**
 * Migration Service - Handles schema versioning and migrations
 */

import { getLogger } from './logger';

// Schema version constants
export const SCHEMA_VERSION = 2;

export interface Migration {
    version: number;
    description: string;
    up: (connection: any) => Promise<void>;
    down: (connection: any) => Promise<void>;
}

/**
 * Migration Service for managing database schema versions
 */
export class MigrationService {
    private connection: any;
    private dimensions: number;

    constructor(connection: any, dimensions: number) {
        this.connection = connection;
        this.dimensions = dimensions;
    }

    /**
     * Get current schema version from database
     */
    async getCurrentVersion(): Promise<number> {
        try {
            // Check if schema_migrations table exists using DuckDB's information schema
            const result = await this.connection.run(`
                SELECT table_name FROM information_schema.tables 
                WHERE table_schema = 'main' AND table_name = 'schema_migrations'
            `);
            const rows = await result.getRows();
            
            if (!rows || rows.length === 0) {
                // Check if indexed_files exists (v0.0.8 schema without migrations table)
                const checkOldSchema = await this.connection.run(`
                    SELECT table_name FROM information_schema.tables 
                    WHERE table_schema = 'main' AND table_name = 'indexed_files'
                `);
                const oldSchemaRows = await checkOldSchema.getRows();
                
                if (oldSchemaRows && oldSchemaRows.length > 0) {
                    // Old schema exists but no migrations table - return 1 to skip initial migration
                    return 1;
                }
                
                return 0; // No migrations table and no old schema means version 0 (fresh install)
            }

            // Get the highest version
            const versionResult = await this.connection.run(`
                SELECT MAX(version) as version FROM schema_migrations
            `);
            const versionRows = await versionResult.getRows();
            
            if (!versionRows || versionRows.length === 0 || versionRows[0][0] === null) {
                return 0;
            }

            // Convert BigInt to Number if necessary
            return Number(versionRows[0][0]);
        } catch (error) {
            const logger = getLogger();
            logger.error('MigrationService', 'Error getting current version', error);
            // Table doesn't exist, return 0
            return 0;
        }
    }

    /**
     * Create schema_migrations table if it doesn't exist
     */
    private async ensureMigrationsTable(): Promise<void> {
        await this.connection.run(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at BIGINT NOT NULL,
                description VARCHAR
            )
        `);
    }

    /**
     * Record a migration as applied
     */
    private async recordMigration(version: number, description: string): Promise<void> {
        const escapedDescription = description.replace(/'/g, "''");
        await this.connection.run(`
            INSERT INTO schema_migrations (version, applied_at, description)
            VALUES (${version}, ${Date.now()}, '${escapedDescription}')
        `);
    }

    /**
     * Get all migrations to apply
     */
    private getMigrations(): Migration[] {
        return [
            {
                version: 1,
                description: 'Initial schema with indexed_files and code_chunks',
                up: async (conn) => {
                    // This is the original v0.0.8 schema - only apply if tables don't exist
                    await conn.run(`
                        CREATE TABLE IF NOT EXISTS indexed_files (
                            file_id VARCHAR PRIMARY KEY,
                            file_path VARCHAR NOT NULL,
                            workspace_path VARCHAR NOT NULL,
                            md5_hash VARCHAR NOT NULL,
                            last_indexed_at BIGINT NOT NULL
                        )
                    `);

                    await conn.run(`
                        CREATE INDEX IF NOT EXISTS idx_workspace_path ON indexed_files(workspace_path)
                    `);
                    await conn.run(`
                        CREATE INDEX IF NOT EXISTS idx_file_path ON indexed_files(file_path)
                    `);

                    await conn.run(`
                        CREATE TABLE IF NOT EXISTS code_chunks (
                            chunk_id VARCHAR PRIMARY KEY,
                            file_id VARCHAR NOT NULL,
                            file_path VARCHAR NOT NULL,
                            workspace_path VARCHAR NOT NULL,
                            content TEXT NOT NULL,
                            line_start INTEGER NOT NULL,
                            line_end INTEGER NOT NULL,
                            token_start INTEGER,
                            token_end INTEGER,
                            language VARCHAR,
                            embedding FLOAT[${this.dimensions}],
                            created_at BIGINT NOT NULL
                        )
                    `);

                    await conn.run(`
                        CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_id)
                    `);
                    await conn.run(`
                        CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON code_chunks(workspace_path)
                    `);
                },
                down: async (conn) => {
                    await conn.run('DROP TABLE IF EXISTS code_chunks');
                    await conn.run('DROP TABLE IF EXISTS indexed_files');
                }
            },
            {
                version: 2,
                description: 'Add workspaces table and hierarchical schema with folder_path',
                up: async (conn) => {
                    const logger = getLogger();
                    logger.info('Migration', 'Starting migration to v2 schema');

                    // 1. Create workspaces table
                    await conn.run(`
                        CREATE TABLE IF NOT EXISTS workspaces (
                            workspace_id VARCHAR PRIMARY KEY,
                            workspace_path VARCHAR NOT NULL,
                            workspace_name VARCHAR,
                            status VARCHAR DEFAULT 'active',
                            created_at BIGINT NOT NULL,
                            last_updated_at BIGINT NOT NULL,
                            total_files INTEGER DEFAULT 0,
                            total_chunks INTEGER DEFAULT 0
                        )
                    `);
                    await conn.run(`
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_unique_path ON workspaces(workspace_path)
                    `);

                    // 2. Migrate existing workspaces from indexed_files
                    // Get unique workspace paths
                    const existingWorkspaces = await conn.run(`
                        SELECT DISTINCT workspace_path FROM indexed_files
                    `);
                    const workspaceRows = await existingWorkspaces.getRows();

                    for (const row of workspaceRows) {
                        const workspacePath = row[0] as string;
                        const workspaceId = this.generateWorkspaceId(workspacePath);
                        const workspaceName = workspacePath.split(/[/\\]/).pop() || workspacePath;
                        
                        // Get file and chunk counts (convert BigInt to Number)
                        const fileCountResult = await conn.run(`
                            SELECT COUNT(*) FROM indexed_files WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'
                        `);
                        const fileCountRows = await fileCountResult.getRows();
                        const fileCount = Number(fileCountRows[0]?.[0] || 0);

                        const chunkCountResult = await conn.run(`
                            SELECT COUNT(*) FROM code_chunks WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'
                        `);
                        const chunkCountRows = await chunkCountResult.getRows();
                        const chunkCount = Number(chunkCountRows[0]?.[0] || 0);

                        await conn.run(`
                            INSERT INTO workspaces (workspace_id, workspace_path, workspace_name, status, created_at, last_updated_at, total_files, total_chunks)
                            VALUES ('${workspaceId}', '${workspacePath.replace(/'/g, "''")}', '${workspaceName.replace(/'/g, "''")}', 'active', ${Date.now()}, ${Date.now()}, ${fileCount}, ${chunkCount})
                        `);
                    }

                    logger.info('Migration', `Migrated ${workspaceRows.length} workspaces`);

                    // 3. Add new columns to indexed_files
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN workspace_id VARCHAR');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN folder_path VARCHAR');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN file_name VARCHAR');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN language VARCHAR');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN file_size BIGINT');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN line_count INTEGER');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN chunk_count INTEGER DEFAULT 0');
                    } catch { /* Column may already exist */ }
                    
                    try {
                        await conn.run('ALTER TABLE indexed_files ADD COLUMN created_at BIGINT');
                    } catch { /* Column may already exist */ }

                    // 4. Populate new columns from existing data
                    // Update workspace_id
                    for (const row of workspaceRows) {
                        const workspacePath = row[0] as string;
                        const workspaceId = this.generateWorkspaceId(workspacePath);
                        await conn.run(`
                            UPDATE indexed_files 
                            SET workspace_id = '${workspaceId}'
                            WHERE workspace_path = '${workspacePath.replace(/'/g, "''")}'
                        `);
                    }

                    // Update folder_path and file_name - use simple defaults
                    // The application code will derive these correctly when reading
                    await conn.run(`
                        UPDATE indexed_files 
                        SET folder_path = ''
                        WHERE folder_path IS NULL
                    `);

                    await conn.run(`
                        UPDATE indexed_files 
                        SET file_name = file_path
                        WHERE file_name IS NULL
                    `);

                    // Update created_at for existing files
                    await conn.run(`
                        UPDATE indexed_files 
                        SET created_at = last_indexed_at
                        WHERE created_at IS NULL
                    `);

                    // Update chunk_count from code_chunks table
                    await conn.run(`
                        UPDATE indexed_files 
                        SET chunk_count = (
                            SELECT COUNT(*) FROM code_chunks 
                            WHERE code_chunks.file_id = indexed_files.file_id
                        )
                    `);

                    // 5. Create new indexes (wrap in try/catch in case they fail)
                    try {
                        await conn.run(`
                            CREATE INDEX IF NOT EXISTS idx_file_workspace_id ON indexed_files(workspace_id)
                        `);
                    } catch (e) {
                        logger.warn('Migration', 'Could not create idx_file_workspace_id', e);
                    }
                    
                    try {
                        await conn.run(`
                            CREATE INDEX IF NOT EXISTS idx_file_folder ON indexed_files(workspace_id, folder_path)
                        `);
                    } catch (e) {
                        logger.warn('Migration', 'Could not create idx_file_folder', e);
                    }
                    
                    // Skip the unique index as it may conflict with existing data
                    // The application code handles uniqueness

                    // 6. Add chunk_index to code_chunks if not exists
                    try {
                        await conn.run('ALTER TABLE code_chunks ADD COLUMN chunk_index INTEGER DEFAULT 0');
                    } catch { /* Column may already exist */ }

                    logger.info('Migration', 'Migration to v2 schema completed');
                },
                down: async (conn) => {
                    // Rollback: drop new columns and table
                    await conn.run('DROP INDEX IF EXISTS idx_file_workspace_id');
                    await conn.run('DROP INDEX IF EXISTS idx_file_folder');
                    await conn.run('DROP INDEX IF EXISTS idx_file_unique_path');
                    await conn.run('DROP TABLE IF EXISTS workspaces');
                    // Note: DuckDB doesn't support DROP COLUMN, so we'd need to recreate the table
                    // For simplicity, we leave the extra columns
                }
            }
        ];
    }

    /**
     * Generate a workspace ID from path
     */
    private generateWorkspaceId(workspacePath: string): string {
        // Use a simple hash-based ID
        const crypto = require('crypto');
        return crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 16);
    }

    /**
     * Run all pending migrations
     */
    async migrate(): Promise<void> {
        const logger = getLogger();
        
        await this.ensureMigrationsTable();
        
        const currentVersion = await this.getCurrentVersion();
        const migrations = this.getMigrations();
        
        logger.info('Migration', `Current schema version: ${currentVersion}, target version: ${SCHEMA_VERSION}`);

        for (const migration of migrations) {
            if (migration.version > currentVersion) {
                logger.info('Migration', `Applying migration v${migration.version}: ${migration.description}`);
                
                try {
                    await migration.up(this.connection);
                    await this.recordMigration(migration.version, migration.description);
                    logger.info('Migration', `Migration v${migration.version} applied successfully`);
                } catch (error) {
                    logger.error('Migration', `Migration v${migration.version} failed`, error);
                    throw error;
                }
            }
        }
    }

    /**
     * Check if database needs migration
     */
    async needsMigration(): Promise<boolean> {
        const currentVersion = await this.getCurrentVersion();
        return currentVersion < SCHEMA_VERSION;
    }

    /**
     * Rollback to a specific version
     */
    async rollback(targetVersion: number): Promise<void> {
        const logger = getLogger();
        const currentVersion = await this.getCurrentVersion();
        const migrations = this.getMigrations().reverse();

        for (const migration of migrations) {
            if (migration.version > targetVersion && migration.version <= currentVersion) {
                logger.info('Migration', `Rolling back migration v${migration.version}`);
                
                try {
                    await migration.down(this.connection);
                    await this.connection.run(`
                        DELETE FROM schema_migrations WHERE version = ${migration.version}
                    `);
                    logger.info('Migration', `Rollback v${migration.version} completed`);
                } catch (error) {
                    logger.error('Migration', `Rollback v${migration.version} failed`, error);
                    throw error;
                }
            }
        }
    }
}
