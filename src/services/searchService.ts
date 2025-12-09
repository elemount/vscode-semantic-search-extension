/**
 * Search Service - handles semantic search queries
 */

import * as vscode from 'vscode';
import { VectorDbService } from './vectorDbService';
import { SearchResult } from '../models/types';
import { normalizePath } from '../utils/fileUtils';

export class SearchService {
    private vectorDbService: VectorDbService;

    constructor(vectorDbService: VectorDbService) {
        this.vectorDbService = vectorDbService;
    }

    /**
     * Perform semantic search across all indexed files
     */
    async search(query: string, maxResults: number = 10): Promise<SearchResult[]> {
        return this.vectorDbService.search(query, undefined, maxResults);
    }

    /**
     * Perform semantic search within a specific workspace
     */
    async searchInWorkspace(
        query: string,
        workspacePath: string,
        maxResults: number = 10
    ): Promise<SearchResult[]> {
        return this.vectorDbService.search(
            query,
            normalizePath(workspacePath),
            maxResults
        );
    }

    /**
     * Search and return results formatted for display
     */
    async searchFormatted(
        query: string,
        workspacePath?: string,
        maxResults: number = 10
    ): Promise<string> {
        let results: SearchResult[];

        if (workspacePath) {
            results = await this.searchInWorkspace(query, workspacePath, maxResults);
        } else {
            results = await this.search(query, maxResults);
        }

        if (results.length === 0) {
            return 'No results found.';
        }

        let output = `Found ${results.length} result(s):\n\n`;

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const relativePath = workspacePath
                ? result.filePath.replace(normalizePath(workspacePath) + '/', '')
                : result.filePath;

            output += `---\n`;
            output += `**${i + 1}. ${relativePath}** (lines ${result.lineStart}-${result.lineEnd})\n`;
            output += `Score: ${(result.score * 100).toFixed(1)}%\n\n`;
            output += `\`\`\`\n${result.content}\n\`\`\`\n\n`;
        }

        return output;
    }

    /**
     * Search and open the top result in editor
     */
    async searchAndOpen(query: string, workspacePath?: string): Promise<void> {
        let results: SearchResult[];

        if (workspacePath) {
            results = await this.searchInWorkspace(query, workspacePath, 1);
        } else {
            results = await this.search(query, 1);
        }

        if (results.length === 0) {
            vscode.window.showInformationMessage('No results found.');
            return;
        }

        const result = results[0];
        const uri = vscode.Uri.file(result.filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);

        // Scroll to the relevant lines
        const startLine = Math.max(0, result.lineStart - 1);
        const endLine = result.lineEnd - 1;
        const range = new vscode.Range(startLine, 0, endLine, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(startLine, 0, startLine, 0);
    }
}
