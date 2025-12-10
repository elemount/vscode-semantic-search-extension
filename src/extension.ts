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
import { getLogger } from './services/logger';
import { registerBuildIndexCommand, registerIndexFilesCommand } from './commands/buildIndex';
import { registerSearchCommand, registerQuickSearchCommand, registerSearchWithPanelCommand } from './commands/search';
import { registerDeleteIndexCommand, registerDeleteFileIndexCommand } from './commands/deleteIndex';
import { registerIndexSidebarView } from './views/indexSidebar';
import { registerSearchSidebarView } from './views/searchSidebar';
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
    const logger = getLogger();
    logger.info('Extension', 'Semantic Search extension is activating...');

    try {
        // Get storage path for databases
        const storagePath = getStoragePath(context);
        logger.debug('Extension', `Storage path: ${storagePath}`);

        // Initialize status bar manager
        statusBarManager = new StatusBarManager();
        context.subscriptions.push({ dispose: () => statusBarManager.dispose() });

        // Initialize embedding service (but don't load model yet)
        embeddingService = new EmbeddingService(context);
        
        // Initialize vector database service (fast, no model required)
        vectorDbService = new VectorDbService(storagePath, embeddingService);
        await vectorDbService.initialize();

        // Update status to ready (model not loaded yet)
        statusBarManager.updateModelStatus('not-loaded');
        logger.info('Extension', 'Services initialized successfully (model on-demand)');

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

        // Register commands (pass embedding service and status bar for lazy loading)
        context.subscriptions.push(
            registerBuildIndexCommand(context, indexingService, embeddingService, statusBarManager),
            registerIndexFilesCommand(context, indexingService, embeddingService, statusBarManager),
            registerSearchCommand(context, searchService, embeddingService, statusBarManager),
            registerSearchWithPanelCommand(context, searchService, embeddingService, statusBarManager),
            registerQuickSearchCommand(context, searchService, embeddingService, statusBarManager),
            registerDeleteIndexCommand(context, indexingService),
            registerDeleteFileIndexCommand(context, indexingService)
        );

        // Register sidebar view
        const treeView = registerIndexSidebarView(context, indexingService, vectorDbService);
        context.subscriptions.push(treeView);

        // Register search sidebar webview provider
        const { provider: searchSidebarProvider, disposable: searchSidebarDisposable } = 
            registerSearchSidebarView(context, searchService, embeddingService, statusBarManager);
        context.subscriptions.push(searchSidebarDisposable);

        // Register search sidebar commands
        context.subscriptions.push(
            vscode.commands.registerCommand('semantic-search.focusSearchInput', () => {
                vscode.commands.executeCommand('semanticSearchSidebar.focus');
                searchSidebarProvider.focusSearchInput();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('semantic-search.clearSearchResults', () => {
                searchSidebarProvider.clearResults();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('semantic-search.openSearchInPanel', () => {
                searchSidebarProvider.openInPanel();
            })
        );

        // Register Language Model Tool for Copilot integration
        registerSemanticSearchTool(context, searchService, embeddingService, statusBarManager);

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
        logger.info('Extension', 'Semantic Search extension activated successfully');
    } catch (error) {
        logger.error('Extension', 'Failed to activate Semantic Search extension', error);
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
    const logger = getLogger();
    logger.info('Extension', 'Deactivating Semantic Search extension...');

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

        logger.info('Extension', 'Semantic Search extension deactivated');
    } catch (error) {
        logger.error('Extension', 'Error during deactivation', error);
    }

    // Dispose logger last
    getLogger().dispose();
}
