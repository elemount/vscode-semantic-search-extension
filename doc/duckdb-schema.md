# DuckDB Schema Documentation

This document describes the database schema used by the Semantic Search VS Code extension for storing indexed code and vector embeddings.

## Schema Version

Current schema version: **2**

## Overview

The database uses DuckDB with the VSS (Vector Similarity Search) extension to provide efficient vector search capabilities. The schema follows a hierarchical structure:

```
workspaces
    └── indexed_files
            └── code_chunks (with embeddings)
```

## Tables

### `schema_migrations`

Tracks applied schema migrations for version control.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `version` | INTEGER | PRIMARY KEY | Migration version number |
| `applied_at` | BIGINT | NOT NULL | Unix timestamp when migration was applied |
| `description` | VARCHAR | | Human-readable description of the migration |

### `workspaces`

Top-level workspace tracking. Each VS Code workspace folder gets an entry.

| Column | Type | Constraints | Default | Description |
|--------|------|-------------|---------|-------------|
| `workspace_id` | VARCHAR | PRIMARY KEY | | UUID (MD5 hash of path, first 16 chars) |
| `workspace_path` | VARCHAR | NOT NULL, UNIQUE | | Absolute path to workspace folder |
| `workspace_name` | VARCHAR | | | Display name (folder name) |
| `status` | VARCHAR | | 'active' | Status: 'active', 'indexing', 'error' |
| `created_at` | BIGINT | NOT NULL | | Unix timestamp when workspace was added |
| `last_updated_at` | BIGINT | NOT NULL | | Unix timestamp of last index update |
| `total_files` | INTEGER | | 0 | Count of indexed files in workspace |
| `total_chunks` | INTEGER | | 0 | Count of code chunks in workspace |

**Indexes:**
- `idx_workspace_unique_path` - UNIQUE index on `workspace_path`

### `indexed_files`

File metadata with derived folder structure for tree view.

| Column | Type | Constraints | Default | Description |
|--------|------|-------------|---------|-------------|
| `file_id` | VARCHAR | PRIMARY KEY | | UUID (MD5 hash of workspace + file path) |
| `workspace_id` | VARCHAR | | | Reference to workspaces table |
| `file_path` | VARCHAR | NOT NULL | | Full relative path, e.g., 'src/components/Button.tsx' |
| `folder_path` | VARCHAR | | | Derived folder path, e.g., 'src/components' |
| `file_name` | VARCHAR | | | Just the filename, e.g., 'Button.tsx' |
| `workspace_path` | VARCHAR | NOT NULL | | Absolute workspace path (for backward compat) |
| `md5_hash` | VARCHAR | NOT NULL | | MD5 hash of file content for change detection |
| `language` | VARCHAR | | | Programming language (e.g., 'typescript') |
| `file_size` | BIGINT | | | File size in bytes |
| `line_count` | INTEGER | | | Number of lines in file |
| `chunk_count` | INTEGER | | 0 | Number of code chunks for this file |
| `created_at` | BIGINT | | | Unix timestamp when file was first indexed |
| `last_indexed_at` | BIGINT | NOT NULL | | Unix timestamp of last indexing |

**Indexes:**
- `idx_workspace_path` - Index on `workspace_path`
- `idx_file_path` - Index on `file_path`
- `idx_file_workspace_id` - Index on `workspace_id`
- `idx_file_folder` - Composite index on `(workspace_id, folder_path)`
- `idx_file_unique_path` - UNIQUE index on `(workspace_id, file_path)`

### `code_chunks`

Vector embeddings and content for code segments.

| Column | Type | Constraints | Default | Description |
|--------|------|-------------|---------|-------------|
| `chunk_id` | VARCHAR | PRIMARY KEY | | UUID (derived from file_id + line range) |
| `file_id` | VARCHAR | NOT NULL | | Reference to indexed_files table |
| `file_path` | VARCHAR | NOT NULL | | File path (denormalized for query efficiency) |
| `workspace_path` | VARCHAR | NOT NULL | | Workspace path (denormalized) |
| `content` | TEXT | NOT NULL | | The actual code content |
| `line_start` | INTEGER | NOT NULL | | Starting line number (1-indexed) |
| `line_end` | INTEGER | NOT NULL | | Ending line number (1-indexed) |
| `chunk_index` | INTEGER | | 0 | Order of chunk within file |
| `token_start` | INTEGER | | | Starting token position |
| `token_end` | INTEGER | | | Ending token position |
| `language` | VARCHAR | | | Programming language |
| `embedding` | FLOAT[768] | | | Vector embedding (dimension depends on model) |
| `created_at` | BIGINT | NOT NULL | | Unix timestamp when chunk was created |

**Indexes:**
- `idx_chunks_file` - Index on `file_id`
- `idx_chunks_workspace` - Index on `workspace_path`
- `idx_chunks_embedding` - HNSW index on `embedding` (cosine metric)

## Relationships

```
workspaces (1) ────────────────────────── (N) indexed_files
              workspace_path = workspace_path
                   workspace_id

indexed_files (1) ─────────────────────── (N) code_chunks
                  file_id = file_id
```

## Common Queries

### Get folder hierarchy with file counts

```sql
SELECT 
    folder_path,
    COUNT(*) as file_count,
    SUM(chunk_count) as total_chunks
FROM indexed_files
WHERE workspace_path = ?
GROUP BY folder_path
ORDER BY folder_path;
```

### Get files in a specific folder

```sql
SELECT file_id, file_name, chunk_count, last_indexed_at
FROM indexed_files
WHERE workspace_path = ? AND folder_path = ?
ORDER BY file_name;
```

### Search for similar code (vector search)

```sql
SELECT 
    chunk_id,
    file_path,
    content,
    line_start,
    line_end,
    array_cosine_distance(embedding, ?::FLOAT[768]) AS distance
FROM code_chunks
WHERE workspace_path = ?
ORDER BY array_cosine_distance(embedding, ?::FLOAT[768])
LIMIT 10;
```

### Get workspace statistics

```sql
SELECT 
    w.workspace_name,
    w.total_files,
    w.total_chunks,
    w.last_updated_at
FROM workspaces w
WHERE w.workspace_path = ?;
```

### Get chunks for a file (for tree view)

```sql
SELECT chunk_id, content, line_start, line_end, chunk_index
FROM code_chunks
WHERE file_id = ?
ORDER BY chunk_index, line_start;
```

## Design Decisions

### Derived Folder Hierarchy

The folder structure is derived from `file_path` rather than maintained in a separate table:

**Benefits:**
- Simpler maintenance - no need to create/delete folder records
- Natural fit for file watching - file events already have full paths
- Tree view is just a presentation concern - build it from grouped paths
- Matches VS Code's model - VS Code works with file URIs, not folder entities
- Fewer JOINs for common operations

### Denormalized Paths in code_chunks

`file_path` and `workspace_path` are duplicated in `code_chunks` to:
- Enable efficient workspace-scoped searches without JOINs
- Support vector search filtering in a single query
- Maintain compatibility with existing queries

### HNSW Index for Vector Search

Uses DuckDB's HNSW (Hierarchical Navigable Small World) index:
- Metric: cosine similarity
- Enables sub-linear time approximate nearest neighbor search
- Persistent across sessions with `hnsw_enable_experimental_persistence`

## Schema Migration History

| Version | Description |
|---------|-------------|
| 1 | Initial schema with indexed_files and code_chunks |
| 2 | Added workspaces table, folder_path, and hierarchical structure |

## Embedding Dimensions

The embedding dimension (768 by default) depends on the model used:
- `Xenova/all-MiniLM-L6-v2`: 384 dimensions
- `Xenova/bge-base-en-v1.5`: 768 dimensions (default)
- Other models may vary
