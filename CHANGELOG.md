# Change Log

All notable changes to the "semantic-search" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.9] - 2024-12-10

### Added
- **Hierarchical Database Schema**: New workspace → folder → file → chunk hierarchy
  - `workspaces` table for top-level workspace tracking
  - `folder_path` derived column for efficient grouping
  - Schema version tracking with `schema_migrations` table
  - Automatic migration from v0.0.8 schema
- **Enhanced Tree View**: Browse indexed content with chunk details
  - Expand files to see individual code chunks
  - Click chunks to jump to specific line ranges
  - New "Toggle Show Chunks" command
  - New "Reveal in Explorer" context menu option
  - New "Copy Path" context menu option
- **Schema Documentation**: Complete documentation in `doc/duckdb-schema.md`
  - Table definitions with column descriptions
  - Relationship diagrams
  - Common query patterns
  - Migration history

### Changed
- **IndexedFile interface**: Added new fields
  - `workspaceId`, `folderPath`, `fileName`, `chunkCount`, `createdAt`
  - Backward compatible with existing data through migration
- **VectorDbService**: New methods for hierarchical queries
  - `getWorkspaceByPath()`, `getAllWorkspaces()`, `updateWorkspaceStats()`
  - `getFolderHierarchy()`, `getFilesInFolder()`
  - `getChunksForFile()` for tree view
- **MigrationService**: Handles schema version upgrades
  - Automatic detection and migration on startup
  - Preserves existing data during upgrade

### Developer Experience
- Cleaner separation of workspace, folder, and file concerns
- Better database indexing for tree view performance
- Comprehensive schema documentation for contributors

## [0.0.8] - 2024-12-10

### Changed
- **Instant Activation**: Extension now activates in <500ms by deferring model loading
  - Embedding model loads on-demand (first search or index operation)
  - Database initialization only during activation (fast)
  - All commands and views available immediately
  - Non-blocking model download with progress in status bar

### Added
- **Lazy Loading State Management**: New `EmbeddingServiceState` type
  - States: `'not-loaded' | 'loading' | 'ready' | 'error'`
  - `ensureInitialized()` method for on-demand model loading
  - `getState()` method to check initialization status
- **Enhanced Status Bar**: Displays model loading progress
  - Initial: `"$(database) Ready"` with "Model: On-demand" tooltip
  - Loading: `"$(sync~spin) Loading 45%"` with real-time progress
  - Ready: `"$(check) Search Ready"`
- **Silent Copilot Integration**: Tool automatically loads model when needed

### Developer Experience
- Faster development iteration (no waiting for model on every reload)
- Users browsing index never trigger model download
- Database operations (view, delete) work without model
- Better first-time user experience

## [0.0.6] - 2024-12-10

### Added
- **Logging System**: Centralized logging service with configurable log levels
  - New `semanticSearch.logging.level` setting (error, warn, info, debug)
  - Logs to "Semantic Search" output channel
  - Automatic sanitization of sensitive data (API keys, tokens)
  - Dynamic log level updates without restart
- **VS Code Test Integration**: Official test runner setup
  - New test suite structure with `runTest.ts`
  - Extended test coverage for extension activation, commands, and configuration
  - Logger service tests
  - Token chunker tests
- **GitHub Actions CI**: Automated testing and linting
  - Multi-platform testing (Ubuntu, Windows, macOS)
  - Runs on push and pull requests to main branch
  - CI status badge in README.md

### Changed
- Replaced all `console.log`/`console.error` calls with structured logging
- Moved test files to `src/test/suite/` directory
- Improved extension activation tests with better assertions

### Developer Experience
- Consistent log formatting with timestamps and component context
- Better error visibility and debugging capabilities
- Automated CI pipeline for quality assurance

## [0.0.3] - 2024-12-10

### Changed
- **Architecture Overhaul**: Replaced ChromaDB with DuckDB VSS extension for vector storage
- Use Transformers.js directly (`@huggingface/transformers`) for embedding generation
- Single database file for both vectors and metadata
- No external processes or platform-specific binaries required

### Added
- `EmbeddingService` - Uses onnx-community/embeddinggemma-300m-ONNX model (768 dimensions)
- `VectorDbService` - DuckDB with HNSW index for cosine similarity search
- Model download progress indicator on first activation

### Removed
- ChromaDB dependency and server process
- Platform-specific Chroma executables in `bin/` directory
- `chromadb` and `chromadb-default-embed` npm packages
- Chroma-related settings (`semanticSearch.chroma.*`)
- Server status indicator and restart commands

### Migration Notes
- Users upgrading from v0.0.2 will need to rebuild their index
- First activation will download the embedding model (~12MB)

## [0.0.1] - Initial Release

### Added
- Build Index command for workspace indexing
- Semantic Search command with natural language queries
- Index Sidebar view in Explorer
- GitHub Copilot Language Model Tool integration
- DuckDB metadata storage
- ChromaDB vector storage