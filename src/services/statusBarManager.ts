/**
 * Status Bar Manager
 * Manages status bar items for indexing progress and embedding model status
 */

import * as vscode from 'vscode';
import { IndexingStatus } from '../models/types';

export type ModelStatus = 'loading' | 'ready' | 'error';

export class StatusBarManager {
    private modelStatusItem: vscode.StatusBarItem;
    private indexingStatusItem: vscode.StatusBarItem;

    constructor() {
        // Create model status item
        this.modelStatusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.modelStatusItem.name = 'Semantic Search Model';
        this.updateModelStatus('loading');
        this.modelStatusItem.show();

        // Create indexing status item
        this.indexingStatusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        this.indexingStatusItem.name = 'Semantic Search Indexing';
        this.indexingStatusItem.hide(); // Only show when indexing
    }

    /**
     * Update embedding model status display
     */
    updateModelStatus(status: ModelStatus): void {
        switch (status) {
            case 'loading':
                this.modelStatusItem.text = '$(sync~spin) Semantic Search';
                this.modelStatusItem.tooltip = 'Loading embedding model...';
                this.modelStatusItem.backgroundColor = undefined;
                break;
            case 'ready':
                this.modelStatusItem.text = '$(check) Semantic Search';
                this.modelStatusItem.tooltip = 'Semantic Search is ready';
                this.modelStatusItem.backgroundColor = undefined;
                break;
            case 'error':
                this.modelStatusItem.text = '$(error) Semantic Search';
                this.modelStatusItem.tooltip = 'Semantic Search error';
                this.modelStatusItem.backgroundColor = new vscode.ThemeColor(
                    'statusBarItem.errorBackground'
                );
                break;
        }
    }

    /**
     * Update indexing status display
     */
    updateIndexingStatus(status: IndexingStatus): void {
        if (!status.isIndexing) {
            this.indexingStatusItem.hide();
            return;
        }

        const progress = status.totalFiles > 0
            ? Math.round((status.processedFiles / status.totalFiles) * 100)
            : 0;

        this.indexingStatusItem.text = `$(sync~spin) Indexing ${progress}%`;
        this.indexingStatusItem.tooltip = status.currentFile
            ? `Indexing: ${status.currentFile}\n${status.processedFiles}/${status.totalFiles} files`
            : `Indexing: ${status.processedFiles}/${status.totalFiles} files`;
        this.indexingStatusItem.show();
    }

    /**
     * Show stale index indicator
     */
    showStaleIndicator(staleCount: number): void {
        if (staleCount > 0) {
            this.indexingStatusItem.text = `$(warning) ${staleCount} stale`;
            this.indexingStatusItem.tooltip = `${staleCount} files have changed since last indexing`;
            this.indexingStatusItem.command = 'semantic-search.buildIndex';
            this.indexingStatusItem.show();
        } else {
            this.indexingStatusItem.hide();
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.modelStatusItem.dispose();
        this.indexingStatusItem.dispose();
    }
}
