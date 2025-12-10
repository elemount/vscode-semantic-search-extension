/**
 * Search Results Webview
 * Provides a rich UI for displaying semantic search results with syntax highlighting
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SearchResult } from '../models/types';
import { loadTemplate, loadCss } from '../utils/templateLoader';

export class SearchResultsPanel {
    public static currentPanel: SearchResultsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _results: SearchResult[] = [];
    private _query: string = '';
    private _workspacePath?: string;

    public static createOrShow(
        extensionUri: vscode.Uri,
        results: SearchResult[],
        query: string,
        workspacePath?: string
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (SearchResultsPanel.currentPanel) {
            SearchResultsPanel.currentPanel._panel.reveal(column);
            SearchResultsPanel.currentPanel.updateResults(results, query, workspacePath);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'semanticSearchResults',
            'Semantic Search Results',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        SearchResultsPanel.currentPanel = new SearchResultsPanel(
            panel,
            extensionUri,
            results,
            query,
            workspacePath
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        results: SearchResult[],
        query: string,
        workspacePath?: string
    ) {
        this._panel = panel;
        this._results = results;
        this._query = query;
        this._workspacePath = workspacePath;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'openFile':
                        await this._openFile(message.filePath, message.lineStart, message.lineEnd);
                        break;
                    case 'filterByType':
                        this._filterByType(message.extension);
                        break;
                    case 'filterByFolder':
                        this._filterByFolder(message.folder);
                        break;
                    case 'sortBy':
                        this._sortBy(message.sortField);
                        break;
                    case 'clearFilters':
                        this._clearFilters();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public updateResults(results: SearchResult[], query: string, workspacePath?: string): void {
        this._results = results;
        this._query = query;
        this._workspacePath = workspacePath;
        this._update();
    }

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

    private _filterByType(extension: string): void {
        // Filter results by file extension
        const filtered = this._results.filter((r) =>
            extension === 'all' ? true : path.extname(r.filePath).toLowerCase() === extension
        );
        this._panel.webview.postMessage({
            command: 'updateResults',
            results: this._formatResults(filtered),
        });
    }

    private _filterByFolder(folder: string): void {
        // Filter results by folder
        const filtered = this._results.filter((r) =>
            folder === 'all' ? true : r.filePath.includes(folder)
        );
        this._panel.webview.postMessage({
            command: 'updateResults',
            results: this._formatResults(filtered),
        });
    }

    private _sortBy(field: 'relevance' | 'path' | 'lines'): void {
        const sorted = [...this._results];
        switch (field) {
            case 'relevance':
                sorted.sort((a, b) => b.score - a.score);
                break;
            case 'path':
                sorted.sort((a, b) => a.filePath.localeCompare(b.filePath));
                break;
            case 'lines':
                sorted.sort((a, b) => a.lineStart - b.lineStart);
                break;
        }
        this._panel.webview.postMessage({
            command: 'updateResults',
            results: this._formatResults(sorted),
        });
    }

    private _clearFilters(): void {
        this._panel.webview.postMessage({
            command: 'updateResults',
            results: this._formatResults(this._results),
        });
    }

    private _formatResults(results: SearchResult[]): object[] {
        return results.map((r, index) => ({
            index: index + 1,
            filePath: r.filePath,
            relativePath: this._workspacePath
                ? r.filePath.replace(this._workspacePath, '').replace(/^[/\\]/, '')
                : r.filePath,
            lineStart: r.lineStart,
            lineEnd: r.lineEnd,
            content: r.content,
            score: r.score,
            scorePercent: Math.round(r.score * 100),
            extension: path.extname(r.filePath).toLowerCase(),
            folder: path.dirname(
                this._workspacePath
                    ? r.filePath.replace(this._workspacePath, '').replace(/^[/\\]/, '')
                    : r.filePath
            ),
        }));
    }

    private _getFileTypeFilters(): { label: string; value: string }[] {
        const extensions = new Set(this._results.map((r) => path.extname(r.filePath).toLowerCase()));
        const filters = [{ label: 'All types', value: 'all' }];
        for (const ext of extensions) {
            if (ext) {
                filters.push({ label: ext, value: ext });
            }
        }
        return filters;
    }

    private _getFolderFilters(): { label: string; value: string }[] {
        const folders = new Set(
            this._results.map((r) => {
                const relativePath = this._workspacePath
                    ? r.filePath.replace(this._workspacePath, '').replace(/^[/\\]/, '')
                    : r.filePath;
                return path.dirname(relativePath);
            })
        );
        const filters = [{ label: 'All folders', value: 'all' }];
        for (const folder of folders) {
            if (folder && folder !== '.') {
                filters.push({ label: folder, value: folder });
            }
        }
        return filters;
    }

    private _update(): void {
        this._panel.title = `Search: ${this._query}`;
        this._updateHtml();
    }

    private async _updateHtml(): Promise<void> {
        this._panel.webview.html = await this._getHtmlForWebview();
    }

    private async _getHtmlForWebview(): Promise<string> {
        const results = this._formatResults(this._results);
        const typeFilters = this._getFileTypeFilters();
        const folderFilters = this._getFolderFilters();

        const htmlTemplate = await loadTemplate(this._extensionUri, 'searchResultsPanel.html.template');
        const cssContent = await loadCss(this._extensionUri, 'searchResultsPanel.css.template');
        
        const typeFiltersHtml = typeFilters.map((f) => `<option value="${f.value}">${this._escapeHtml(f.label)}</option>`).join('');
        const folderFiltersHtml = folderFilters.map((f) => `<option value="${f.value}">${this._escapeHtml(f.label)}</option>`).join('');
        const resultsHtml = this._renderResults(results);
        
        return htmlTemplate
            .replace('{{CSS_CONTENT}}', cssContent)
            .replace('{{QUERY}}', this._escapeHtml(this._query))
            .replace('{{RESULT_COUNT}}', results.length.toString())
            .replace('{{TYPE_FILTERS}}', typeFiltersHtml)
            .replace('{{FOLDER_FILTERS}}', folderFiltersHtml)
            .replace('{{RESULTS_HTML}}', resultsHtml);
    }

    private _renderResults(results: object[]): string {
        if (results.length === 0) {
            return '<div class="no-results">No results found</div>';
        }

        return results
            .map(
                (r: any) => `
            <div class="result-card">
                <div class="result-header" onclick="openFile('${this._escapeHtml(r.filePath)}', ${r.lineStart}, ${r.lineEnd})">
                    <div class="result-path">
                        <span class="result-index">#${r.index}</span>
                        <span class="icon">📄</span>
                        <span class="result-file">${this._escapeHtml(r.relativePath)}</span>
                        <span class="result-lines">Lines ${r.lineStart}-${r.lineEnd}</span>
                    </div>
                    <div class="result-score">
                        <div class="score-bar">
                            <div class="score-fill" style="width: ${r.scorePercent}%"></div>
                        </div>
                        <span class="score-text">${r.scorePercent}%</span>
                    </div>
                </div>
                <div class="result-content">
                    <pre><code>${this._escapeHtml(r.content.substring(0, 500))}${r.content.length > 500 ? '...' : ''}</code></pre>
                </div>
            </div>
        `
            )
            .join('');
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
            .replace(/\\/g, '\\\\');
    }

    public dispose(): void {
        SearchResultsPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
