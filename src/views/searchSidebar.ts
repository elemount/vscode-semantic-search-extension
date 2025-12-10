/**
 * Search Sidebar View Provider
 * Provides a webview-based search interface in the Activity Bar sidebar
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SearchService } from '../services/searchService';
import { SearchResult } from '../models/types';
import { SearchResultsPanel } from './searchResultsPanel';
import { getLogger } from '../services/logger';
import { minimatch } from 'minimatch';
import { loadTemplate, loadCss } from '../utils/templateLoader';

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

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = await this._getHtmlContent(webviewView.webview);

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
            getLogger().error('SearchSidebar', 'Search error', error);
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
    private async _getHtmlContent(_webview: vscode.Webview): Promise<string> {
        const htmlTemplate = await loadTemplate(this._extensionUri, 'searchSidebar.html.template');
        const cssContent = await loadCss(this._extensionUri, 'searchSidebar.css.template');
        
        return htmlTemplate.replace('{{CSS_CONTENT}}', cssContent);
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
