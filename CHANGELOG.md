# Change Log

All notable changes to the "semantic-search" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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