/**
 * Search Sidebar View Provider
 * Provides a webview-based search interface in the Activity Bar sidebar
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SearchService } from '../services/searchService';
import { SearchResult } from '../models/types';
import { SearchResultsPanel } from './searchResultsPanel';
import { minimatch } from 'minimatch';

export class SearchSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'semanticSearchSidebar';

    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _searchService: SearchService;
    private _lastResults: SearchResult[] = [];
    private _lastQuery: string = '';
    private _lastIncludePattern: string = '';
    private _lastExcludePattern: string = '';

    constructor(extensionUri: vscode.Uri, searchService: SearchService) {
        this._extensionUri = extensionUri;
        this._searchService = searchService;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            await this._handleMessage(message);
        });
    }

    /**
     * Focus the search input field
     */
    public focusSearchInput(): void {
        if (this._view) {
            this._view.webview.postMessage({ command: 'focusInput' });
        }
    }

    /**
     * Clear search results
     */
    public clearResults(): void {
        this._lastResults = [];
        this._lastQuery = '';
        if (this._view) {
            this._view.webview.postMessage({ command: 'clearResults' });
        }
    }

    /**
     * Open last search results in the full panel
     */
    public openInPanel(): void {
        if (this._lastResults.length > 0) {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            SearchResultsPanel.createOrShow(
                this._extensionUri,
                this._lastResults,
                this._lastQuery,
                workspacePath
            );
        } else {
            vscode.window.showInformationMessage('No search results to display. Please perform a search first.');
        }
    }

    /**
     * Handle messages from the webview
     */
    private async _handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'search':
                await this._performSearch(
                    message.query,
                    message.includePattern,
                    message.excludePattern
                );
                break;
            case 'openFile':
                await this._openFile(message.filePath, message.lineStart, message.lineEnd);
                break;
            case 'openInPanel':
                this.openInPanel();
                break;
        }
    }

    /**
     * Perform semantic search with optional filters
     */
    private async _performSearch(
        query: string,
        includePattern?: string,
        excludePattern?: string
    ): Promise<void> {
        if (!query.trim()) {
            vscode.window.showWarningMessage('Please enter a search query.');
            return;
        }

        // Show loading state
        if (this._view) {
            this._view.webview.postMessage({ command: 'showLoading' });
        }

        try {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const maxResults = vscode.workspace.getConfiguration('semanticSearch').get<number>('maxResults', 10);

            let results: SearchResult[];
            if (workspacePath) {
                results = await this._searchService.searchInWorkspace(query, workspacePath, maxResults * 2); // Get more to filter
            } else {
                results = await this._searchService.search(query, maxResults * 2);
            }

            // Apply include pattern filter
            if (includePattern && includePattern.trim()) {
                const patterns = includePattern.split(',').map(p => p.trim()).filter(p => p);
                results = results.filter(r => {
                    const relativePath = workspacePath
                        ? r.filePath.replace(workspacePath, '').replace(/^[/\\]/, '')
                        : r.filePath;
                    return patterns.some(pattern => minimatch(relativePath, pattern, { matchBase: true }));
                });
            }

            // Apply exclude pattern filter
            if (excludePattern && excludePattern.trim()) {
                const patterns = excludePattern.split(',').map(p => p.trim()).filter(p => p);
                results = results.filter(r => {
                    const relativePath = workspacePath
                        ? r.filePath.replace(workspacePath, '').replace(/^[/\\]/, '')
                        : r.filePath;
                    return !patterns.some(pattern => minimatch(relativePath, pattern, { matchBase: true }));
                });
            }

            // Limit results
            results = results.slice(0, maxResults);

            // Store results for later use
            this._lastResults = results;
            this._lastQuery = query;
            this._lastIncludePattern = includePattern || '';
            this._lastExcludePattern = excludePattern || '';

            // Format results for the webview
            const formattedResults = results.map((r, index) => ({
                index: index + 1,
                filePath: r.filePath,
                relativePath: workspacePath
                    ? r.filePath.replace(workspacePath, '').replace(/^[/\\]/, '')
                    : r.filePath,
                lineStart: r.lineStart,
                lineEnd: r.lineEnd,
                content: r.content,
                score: r.score,
                scorePercent: Math.round(r.score * 100),
                extension: path.extname(r.filePath).toLowerCase(),
            }));

            // Count unique files
            const uniqueFiles = new Set(results.map(r => r.filePath));

            // Send results to webview
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'updateResults',
                    results: formattedResults,
                    query: query,
                    totalCount: results.length,
                    fileCount: uniqueFiles.size,
                });
            }
        } catch (error) {
            console.error('Search error:', error);
            vscode.window.showErrorMessage(
                `Search failed: ${error instanceof Error ? error.message : String(error)}`
            );
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'showError',
                    message: 'Search failed. Please try again.',
                });
            }
        }
    }

    /**
     * Open a file at a specific line range
     */
    private async _openFile(filePath: string, lineStart: number, lineEnd: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

            const startLine = Math.max(0, lineStart - 1);
            const endLine = lineEnd - 1;
            const range = new vscode.Range(startLine, 0, endLine, 0);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(startLine, 0, endLine, 0);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
    }

    /**
     * Get the HTML content for the webview
     */
    private _getHtmlContent(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Semantic Search</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 0;
            line-height: 1.4;
        }
        
        .search-container {
            padding: 8px;
        }
        
        .input-group {
            margin-bottom: 8px;
        }
        
        .search-input {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, transparent);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
            outline: none;
            font-family: inherit;
            font-size: inherit;
        }
        
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        
        .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        
        .filter-section {
            margin-top: 0;
            position: relative;
        }
        
        .details-toggle {
            position: absolute;
            right: -4px;
            top: -12px;
            cursor: pointer;
            width: 25px;
            height: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            color: var(--vscode-descriptionForeground);
            user-select: none;
            border: none;
            background: transparent;
        }
        
        .details-content {
            display: none;
            margin-top: 4px;
        }
        
        .details-content.expanded {
            display: block;
        }
        
        .filter-group {
            margin-bottom: 8px;
        }
        
        .filter-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            display: block;
        }

        .filter-input {
            width: 100%;
            padding: 4px 6px;
            border: 1px solid var(--vscode-input-border, transparent);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
            outline: none;
            font-family: inherit;
            font-size: 12px;
        }
        
        .filter-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        
        .button-group {
            display: flex;
            gap: 4px;
            margin-top: 8px;
        }
        
        .results-header {
            padding: 2px;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-sideBarSectionHeader-foreground);
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
        }
        
        .results-container {
            max-height: calc(100vh - 200px);
            overflow-y: auto;
        }
        
        .result-item {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
            cursor: pointer;
        }
        
        .result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .result-header {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 4px;
        }
        
        .result-icon {
            font-size: 14px;
            opacity: 0.8;
        }
        
        .result-path {
            flex: 1;
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-textLink-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .result-score {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 6px;
            border-radius: 10px;
        }
        
        .result-location {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .result-preview {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            background-color: var(--vscode-textCodeBlock-background);
            padding: 6px 8px;
            border-radius: 3px;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 80px;
            overflow: hidden;
            color: var(--vscode-foreground);
            line-height: 1.3;
        }
        
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading-spinner {
            width: 16px;
            height: 16px;
            border: 2px solid var(--vscode-progressBar-background);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 8px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .empty-state {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        
        .error-state {
            padding: 12px;
            text-align: center;
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            margin: 8px;
            border-radius: 3px;
        }
        
        .hidden {
            display: none !important;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <!-- Search Input -->
        <div class="input-group">
            <input type="text" 
                   class="search-input" 
                   id="queryInput" 
                   placeholder="Ask a question...">
        </div>
        
        <!-- Toggle Search Details -->
        <div class="filter-section">
            <div class="details-toggle" id="detailsToggle" onclick="toggleDetails()" title="Toggle Search Details">···</div>
            <div class="details-content" id="detailsContent">
                <!-- Files to Include -->
                <div class="filter-group">
                    <label class="filter-label">files to include</label>
                    <input type="text" 
                           class="filter-input" 
                           id="includeInput" 
                           placeholder="e.g. src/**/*.ts, **/*.js">
                </div>
                
                <!-- Files to Exclude -->
                <div class="filter-group">
                    <label class="filter-label">files to exclude</label>
                    <input type="text" 
                           class="filter-input" 
                           id="excludeInput" 
                           placeholder="e.g. **/test/**, **/*.test.ts">
                </div>
            </div>
        </div>
    </div>
    
    <!-- Results Header -->
    <div class="results-header hidden" id="resultsHeader">
        <span id="resultsCount">results</span>
    </div>
    
    <!-- Loading State -->
    <div class="loading hidden" id="loadingState">
        <div class="loading-spinner"></div>
        <span>Searching...</span>
    </div>
    
    <!-- Error State -->
    <div class="error-state hidden" id="errorState">
        <span id="errorMessage"></span>
    </div>
    
    <!-- Empty State -->
    <div class="empty-state" id="emptyState">
        Enter a question to search your codebase semantically.
    </div>
    
    <!-- Results Container -->
    <div class="results-container hidden" id="resultsContainer">
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // State
        let state = {
            detailsExpanded: false,
            results: [],
            query: ''
        };
        
        // Elements
        const queryInput = document.getElementById('queryInput');
        const includeInput = document.getElementById('includeInput');
        const excludeInput = document.getElementById('excludeInput');
        const resultsContainer = document.getElementById('resultsContainer');
        const resultsHeader = document.getElementById('resultsHeader');
        const resultsCount = document.getElementById('resultsCount');
        const loadingState = document.getElementById('loadingState');
        const errorState = document.getElementById('errorState');
        const emptyState = document.getElementById('emptyState');
        const detailsContent = document.getElementById('detailsContent');
        const detailsToggle = document.getElementById('detailsToggle');
        
        // Toggle search details section
        window.toggleDetails = function() {
            state.detailsExpanded = !state.detailsExpanded;
            if (state.detailsExpanded) {
                detailsContent.classList.add('expanded');
            } else {
                detailsContent.classList.remove('expanded');
            }
        };
        
        // Perform search
        function performSearch() {
            const query = queryInput.value.trim();
            const includePattern = includeInput.value.trim();
            const excludePattern = excludeInput.value.trim();
            
            if (!query) {
                return;
            }
            
            vscode.postMessage({
                command: 'search',
                query: query,
                includePattern: includePattern,
                excludePattern: excludePattern
            });
        }
        
        // Open file
        function openFile(filePath, lineStart, lineEnd) {
            vscode.postMessage({
                command: 'openFile',
                filePath: filePath,
                lineStart: lineStart,
                lineEnd: lineEnd
            });
        }
        
        // Open in panel
        function openInPanel() {
            vscode.postMessage({
                command: 'openInPanel'
            });
        }
        
        // Render results
        function renderResults(results) {
            resultsContainer.innerHTML = '';
            
            results.forEach((result) => {
                const item = document.createElement('div');
                item.className = 'result-item';
                item.onclick = () => openFile(result.filePath, result.lineStart, result.lineEnd);
                
                // Truncate content for preview
                const previewContent = result.content.length > 200 
                    ? result.content.substring(0, 200) + '...' 
                    : result.content;
                
                // Get file icon based on extension
                const icon = getFileIcon(result.extension);
                
                item.innerHTML = \`
                    <div class="result-header">
                        <span class="result-icon">\${icon}</span>
                        <span class="result-path" title="\${result.relativePath}">\${result.relativePath}</span>
                        <span class="result-score">\${result.scorePercent}%</span>
                    </div>
                    <div class="result-location">Lines \${result.lineStart}-\${result.lineEnd}</div>
                    <div class="result-preview">\${escapeHtml(previewContent)}</div>
                \`;
                
                resultsContainer.appendChild(item);
            });
        }
        
        // Get file icon
        function getFileIcon(extension) {
            const iconMap = {
                '.ts': '📘',
                '.tsx': '📘',
                '.js': '📒',
                '.jsx': '📒',
                '.py': '🐍',
                '.java': '☕',
                '.cs': '🔷',
                '.go': '🔵',
                '.rs': '🦀',
                '.cpp': '📙',
                '.c': '📙',
                '.h': '📄',
                '.md': '📝',
                '.json': '📋',
                '.yaml': '📋',
                '.yml': '📋',
                '.html': '🌐',
                '.css': '🎨',
                '.scss': '🎨'
            };
            return iconMap[extension] || '📄';
        }
        
        // Escape HTML
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Show loading state
        function showLoading() {
            loadingState.classList.remove('hidden');
            errorState.classList.add('hidden');
            emptyState.classList.add('hidden');
            resultsContainer.classList.add('hidden');
        }
        
        // Show results
        function showResults(results, query, totalCount, fileCount) {
            loadingState.classList.add('hidden');
            errorState.classList.add('hidden');
            resultsHeader.classList.remove('hidden');
            
            if (results.length === 0) {
                emptyState.textContent = 'No results found for "' + query + '"';
                emptyState.classList.remove('hidden');
                resultsContainer.classList.add('hidden');
                resultsCount.textContent = 'No results';
            } else {
                emptyState.classList.add('hidden');
                resultsContainer.classList.remove('hidden');
                const fileText = fileCount === 1 ? 'file' : 'files';
                resultsCount.textContent = totalCount + ' results in ' + fileCount + ' ' + fileText;
                renderResults(results);
            }
            
            state.results = results;
            state.query = query;
        }
        
        // Show error
        function showError(message) {
            loadingState.classList.add('hidden');
            emptyState.classList.add('hidden');
            resultsContainer.classList.add('hidden');
            errorState.classList.remove('hidden');
            document.getElementById('errorMessage').textContent = message;
        }
        
        // Clear results
        function clearResults() {
            emptyState.textContent = 'Enter a question to search your codebase semantically.';
            emptyState.classList.remove('hidden');
            resultsContainer.classList.add('hidden');
            loadingState.classList.add('hidden');
            errorState.classList.add('hidden');
            resultsHeader.classList.add('hidden');
            resultsCount.textContent = 'Results';
            queryInput.value = '';
            state.results = [];
            state.query = '';
        }
            
        queryInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
        
        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            
            switch (message.command) {
                case 'updateResults':
                    showResults(message.results, message.query, message.totalCount, message.fileCount);
                    break;
                case 'showLoading':
                    showLoading();
                    break;
                case 'showError':
                    showError(message.message);
                    break;
                case 'clearResults':
                    clearResults();
                    break;
                case 'focusInput':
                    queryInput.focus();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}

/**
 * Register the search sidebar view provider
 */
export function registerSearchSidebarView(
    context: vscode.ExtensionContext,
    searchService: SearchService
): { provider: SearchSidebarProvider; disposable: vscode.Disposable } {
    const provider = new SearchSidebarProvider(context.extensionUri, searchService);

    const disposable = vscode.window.registerWebviewViewProvider(
        SearchSidebarProvider.viewType,
        provider,
        {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }
    );

    return { provider, disposable };
}
