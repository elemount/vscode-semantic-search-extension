# Semantic Search

A VSCode extension that provides semantic search capabilities for your codebase. Uses DuckDB with VSS extension for vector storage and Transformers.js for embeddings. Integrates with GitHub Copilot through the Language Model Tool API.

## Features

### Build Index
Index your workspace files with embedding vectors for fast semantic search.

- **Build Index Command**: Index all files in your workspace folder
- **Index Files/Folders**: Selectively index specific files or folders from the context menu
- **Automatic Deduplication**: Uses MD5 hashing to skip unchanged files during re-indexing

### Search
Search your codebase using natural language queries.

- **Semantic Search**: Find relevant code snippets based on meaning, not just keywords
- **Quick Search**: Instantly open the top search result
- **GitHub Copilot Integration**: Use semantic search directly from Copilot chat with the `@semantic-search` tool

### Index Management
- **Index Sidebar**: View all indexed files in the Explorer view
- **Stale Detection**: Identifies files that have changed since last indexing
- **Delete Index**: Remove index for specific files or entire workspaces

## Architecture

This extension uses a simplified architecture:

- **Transformers.js** (`@huggingface/transformers`) - Embedding model (onnx-community/embeddinggemma-300m-ONNX, 768 dimensions)
- **DuckDB with VSS extension** - Combined vector storage and metadata in a single database
- **HNSW index** - Fast approximate nearest neighbor search with cosine distance

No external processes or servers required!

## Requirements

This extension requires the following npm packages (installed automatically):

- `@huggingface/transformers` - Embedding model using Transformers.js
- `@duckdb/node-api` - DuckDB database with VSS extension
- `minimatch` - File pattern matching

## Usage

### Building the Index

1. Open a workspace folder in VSCode
2. Run the command **"Semantic Search: Build Index"** from the command palette (Ctrl+Shift+P)
3. Wait for indexing to complete (progress shown in notification)

Note: On first use, the embedding model (~12MB) will be downloaded and cached.

### Searching

1. Run the command **"Semantic Search: Search"** from the command palette
2. Enter your natural language query (e.g., "function that handles user authentication")
3. Select a result to open the file at the relevant location

### Using with GitHub Copilot

In Copilot Chat, you can reference the semantic search tool:

```
@semantic-search find the error handling code
```

The tool will search your indexed codebase and return relevant snippets.

## Commands

| Command | Description |
|---------|-------------|
| `Semantic Search: Build Index` | Index all files in the workspace |
| `Semantic Search: Index Files/Folders` | Index selected files or folders |
| `Semantic Search: Search` | Open semantic search dialog |
| `Semantic Search: Quick Search` | Search and open top result |
| `Semantic Search: Delete Index` | Delete workspace or file index |
| `Semantic Search: Refresh Index View` | Refresh the index sidebar |

## File Types Indexed

By default, the extension indexes common code file types:

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`)
- Python (`.py`)
- Java (`.java`)
- C# (`.cs`)
- Go (`.go`)
- Rust (`.rs`)
- C/C++ (`.c`, `.cpp`, `.h`, `.hpp`)
- Markdown (`.md`)
- JSON, YAML, XML, HTML, CSS

## Excluded Directories

The following directories are excluded by default:

- `node_modules`
- `.git`
- `dist`, `out`, `bin`, `obj`
- `.vscode`

## Data Storage

All index data is stored in a single DuckDB database in the VSCode global storage directory:

- **semantic_search.duckdb**: Contains both vector embeddings (with HNSW index) and file metadata

The embedding model is cached in `~/.cache/huggingface/` or the extension's global storage.

## Known Issues

- First activation may take a few seconds to load the embedding model
- VSS extension persistence is experimental

## Release Notes

### 0.0.3

Architecture overhaul:
- Replaced ChromaDB with DuckDB VSS extension
- Use Transformers.js directly for embeddings (onnx-community/embeddinggemma-300m-ONNX)
- Single database for vectors and metadata
- No external processes or binaries needed
- Simplified deployment

### 0.0.1

Initial release with:
- Build Index command
- Semantic Search command
- Index Sidebar view
- GitHub Copilot Language Model Tool integration

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
