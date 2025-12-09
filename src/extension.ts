/**
 * VSCode Semantic Search Extension
 * 
 * Provides semantic search capabilities for code using DuckDB VSS and Transformers.js.
 * Integrates with GitHub Copilot through the Language Model Tool API.
 */

import * as vscode from 'vscode';
import { EmbeddingService } from './services/embeddingService';
import { VectorDbService } from './services/vectorDbService';
import { IndexingService } from './services/indexingService';
import { SearchService } from './services/searchService';
import { StatusBarManager } from './services/statusBarManager';
import { FileWatcherService } from './services/fileWatcherService';
import { registerBuildIndexCommand, registerIndexFilesCommand } from './commands/buildIndex';
import { registerSearchCommand, registerQuickSearchCommand, registerSearchWithPanelCommand } from './commands/search';
import { registerDeleteIndexCommand, registerDeleteFileIndexCommand } from './commands/deleteIndex';
import { registerIndexSidebarView } from './views/indexSidebar';
import { registerSemanticSearchTool } from './tools/semanticSearchTool';
import { getStoragePath, getIndexingConfigFromSettings } from './utils/fileUtils';

// Global service instances
let embeddingService: EmbeddingService;
let vectorDbService: VectorDbService;
let indexingService: IndexingService;
let searchService: SearchService;
let statusBarManager: StatusBarManager;
let fileWatcherService: FileWatcherService;

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('Semantic Search extension is activating...');

    try {
        // Get storage path for databases
        const storagePath = getStoragePath(context);
        console.log(`Storage path: ${storagePath}`);

        // Initialize status bar manager
        statusBarManager = new StatusBarManager();
        context.subscriptions.push({ dispose: () => statusBarManager.dispose() });

        // Show loading status
        statusBarManager.updateModelStatus('loading');

        // Initialize embedding service with progress
        embeddingService = new EmbeddingService(context);
        
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Semantic Search',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Loading embedding model...' });
                
                await embeddingService.initialize((p) => {
                    if (p.status === 'progress' && p.total) {
                        const percent = Math.round((p.loaded || 0) / p.total * 100);
                        progress.report({ 
                            message: `Downloading model: ${percent}%`,
                            increment: 0
                        });
                    }
                });
                
                progress.report({ message: 'Initializing database...' });
                
                // Initialize vector database service
                vectorDbService = new VectorDbService(storagePath, embeddingService);
                await vectorDbService.initialize();
            }
        );

        // Update status to ready
        statusBarManager.updateModelStatus('ready');
        console.log('Services initialized successfully');

        // Get indexing configuration from settings
        const indexingConfig = getIndexingConfigFromSettings();

        // Create indexing and search services
        indexingService = new IndexingService(vectorDbService, indexingConfig);
        searchService = new SearchService(vectorDbService);

        // Subscribe to indexing status changes
        const indexingStatusDisposable = indexingService.onStatusChange((status) => {
            statusBarManager.updateIndexingStatus(status);
        });
        context.subscriptions.push(indexingStatusDisposable);

        // Initialize file watcher service for auto-indexing
        fileWatcherService = new FileWatcherService(indexingService, indexingConfig);
        fileWatcherService.start();
        context.subscriptions.push({ dispose: () => fileWatcherService.dispose() });

        // Register commands
        context.subscriptions.push(
            registerBuildIndexCommand(context, indexingService),
            registerIndexFilesCommand(context, indexingService),
            registerSearchCommand(context, searchService),
            registerSearchWithPanelCommand(context, searchService),
            registerQuickSearchCommand(context, searchService),
            registerDeleteIndexCommand(context, indexingService),
            registerDeleteFileIndexCommand(context, indexingService)
        );

        // Register sidebar view
        const treeView = registerIndexSidebarView(context, indexingService);
        context.subscriptions.push(treeView);

        // Register Language Model Tool for Copilot integration
        registerSemanticSearchTool(context, searchService);

        // Listen for configuration changes
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('semanticSearch')) {
                    const newConfig = getIndexingConfigFromSettings();
                    fileWatcherService.updateConfig(newConfig);
                    
                    // Restart file watcher if autoIndex setting changed
                    if (event.affectsConfiguration('semanticSearch.autoIndex')) {
                        fileWatcherService.stop();
                        fileWatcherService.start();
                    }
                }
            })
        );

        // Show activation message
        vscode.window.showInformationMessage('Semantic Search is ready!');

        console.log('Semantic Search extension activated successfully');
    } catch (error) {
        console.error('Failed to activate Semantic Search extension:', error);
        statusBarManager?.updateModelStatus('error');
        vscode.window.showErrorMessage(
            `Failed to activate Semantic Search: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Deactivate the extension
 */
export async function deactivate() {
    console.log('Deactivating Semantic Search extension...');

    try {
        // Dispose file watcher
        if (fileWatcherService) {
            fileWatcherService.dispose();
        }

        // Dispose indexing service
        if (indexingService) {
            indexingService.dispose();
        }

        // Close database connections
        if (vectorDbService) {
            await vectorDbService.close();
        }

        // Dispose status bar
        if (statusBarManager) {
            statusBarManager.dispose();
        }

        console.log('Semantic Search extension deactivated');
    } catch (error) {
        console.error('Error during deactivation:', error);
    }
}
