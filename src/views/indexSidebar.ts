/**
 * Index Sidebar View Provider
 * Enhanced tree view with workspace → folder → file → chunk hierarchy
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService } from '../services/indexingService';
import { VectorDbService } from '../services/vectorDbService';
import { IndexEntry, WorkspaceIndex, CodeChunk } from '../models/types';
import { normalizePath } from '../utils/fileUtils';

/**
 * Get file type icon based on extension
 */
function getFileIcon(filePath: string): vscode.ThemeIcon {
    const ext = path.extname(filePath).toLowerCase();
    const iconMap: Record<string, string> = {
        '.ts': 'symbol-method',
        '.tsx': 'symbol-method',
        '.js': 'symbol-method',
        '.jsx': 'symbol-method',
        '.py': 'symbol-method',
        '.java': 'symbol-class',
        '.cs': 'symbol-class',
        '.go': 'symbol-method',
        '.rs': 'symbol-method',
        '.cpp': 'symbol-method',
        '.c': 'symbol-method',
        '.h': 'symbol-interface',
        '.hpp': 'symbol-interface',
        '.md': 'markdown',
        '.json': 'json',
        '.yaml': 'symbol-property',
        '.yml': 'symbol-property',
        '.xml': 'symbol-structure',
        '.html': 'symbol-structure',
        '.css': 'symbol-color',
        '.scss': 'symbol-color',
        '.less': 'symbol-color',
    };
    return new vscode.ThemeIcon(iconMap[ext] || 'file');
}

/**
 * Folder tree node for hierarchical grouping
 */
interface FolderTreeNode {
    name: string;
    fullPath: string;
    children: Map<string, FolderTreeNode>;
    files: IndexEntry[];
}

/**
 * Build a hierarchical folder tree from entries
 */
function buildFolderTree(entries: IndexEntry[]): FolderTreeNode {
    const root: FolderTreeNode = {
        name: '(root)',
        fullPath: '',
        children: new Map(),
        files: []
    };
    
    for (const entry of entries) {
        const folder = path.dirname(entry.relativePath);
        
        if (folder === '.') {
            // File is in root
            root.files.push(entry);
        } else {
            // Navigate/create folder hierarchy
            const parts = folder.split(/[/\\]/);
            let current = root;
            let currentPath = '';
            
            for (const part of parts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                
                if (!current.children.has(part)) {
                    current.children.set(part, {
                        name: part,
                        fullPath: currentPath,
                        children: new Map(),
                        files: []
                    });
                }
                current = current.children.get(part)!;
            }
            
            current.files.push(entry);
        }
    }
    
    return root;
}

/**
 * Get immediate children folders from a folder tree node
 */
function getImmediateChildFolders(root: FolderTreeNode, folderPath: string): FolderTreeNode[] {
    if (!folderPath || folderPath === '(root)') {
        // Return root's immediate children
        return Array.from(root.children.values());
    }
    
    // Navigate to the target folder
    const parts = folderPath.split(/[/\\]/);
    let current = root;
    
    for (const part of parts) {
        const child = current.children.get(part);
        if (!child) {
            return [];
        }
        current = child;
    }
    
    return Array.from(current.children.values());
}

/**
 * Get files directly in a folder (not in subfolders)
 */
function getFilesInFolder(root: FolderTreeNode, folderPath: string): IndexEntry[] {
    if (!folderPath || folderPath === '(root)') {
        return root.files;
    }
    
    // Navigate to the target folder
    const parts = folderPath.split(/[/\\]/);
    let current = root;
    
    for (const part of parts) {
        const child = current.children.get(part);
        if (!child) {
            return [];
        }
        current = child;
    }
    
    return current.files;
}

type TreeItemType = 'workspace' | 'folder' | 'indexedFile' | 'chunk' | 'placeholder';

/**
 * Tree item for the index sidebar
 */
class IndexTreeItem extends vscode.TreeItem {
    public readonly itemType: TreeItemType;
    
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly entry?: IndexEntry,
        public readonly workspaceInfo?: WorkspaceIndex,
        public readonly folderPath?: string,
        public readonly workspacePath?: string,
        public readonly chunk?: CodeChunk,
        public readonly fileUri?: vscode.Uri
    ) {
        super(label, collapsibleState);

        if (chunk && fileUri) {
            this.itemType = 'chunk';
            const lineRange = `Lines ${chunk.lineStart}-${chunk.lineEnd}`;
            this.tooltip = new vscode.MarkdownString(
                `**${lineRange}**\n\n` +
                `\`\`\`\n${chunk.content.substring(0, 200)}${chunk.content.length > 200 ? '...' : ''}\n\`\`\``
            );
            this.description = lineRange;
            this.iconPath = new vscode.ThemeIcon('symbol-snippet');
            this.contextValue = 'chunk';
            
            // Add command to open file at specific line
            this.command = {
                command: 'vscode.open',
                title: 'Open Chunk',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(chunk.lineStart - 1, 0),
                            new vscode.Position(chunk.lineEnd - 1, 0)
                        )
                    }
                ],
            };
        } else if (entry) {
            this.itemType = 'indexedFile';
            const staleIndicator = entry.isStale ? ' $(warning)' : '';
            this.tooltip = new vscode.MarkdownString(
                `**${entry.relativePath}**${staleIndicator}\n\n` +
                `- **Chunks:** ${entry.chunkCount}\n` +
                `- **Last indexed:** ${entry.lastIndexedAt.toLocaleString()}\n` +
                `- **Status:** ${entry.isStale ? '⚠️ Stale (file changed)' : '✅ Up to date'}`
            );
            this.description = entry.isStale ? `${entry.chunkCount} chunks (stale)` : `${entry.chunkCount} chunks`;
            this.iconPath = entry.isStale 
                ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
                : getFileIcon(entry.filePath);
            this.contextValue = 'indexedFile';
            
            // Files are now expandable to show chunks
            // Only add command if not expandable
            if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
                this.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [vscode.Uri.file(entry.filePath)],
                };
            }
        } else if (workspaceInfo) {
            this.itemType = 'workspace';
            const staleCount = 0; // Will be updated dynamically
            this.tooltip = new vscode.MarkdownString(
                `**${workspaceInfo.workspacePath}**\n\n` +
                `- **Files:** ${workspaceInfo.totalFiles}\n` +
                `- **Chunks:** ${workspaceInfo.totalChunks}\n` +
                `- **Last updated:** ${workspaceInfo.lastUpdated.toLocaleString()}`
            );
            this.description = `${workspaceInfo.totalFiles} files, ${workspaceInfo.totalChunks} chunks`;
            this.iconPath = new vscode.ThemeIcon('folder-library');
            this.contextValue = 'workspace';
        } else if (folderPath) {
            this.itemType = 'folder';
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'indexedFolder';
        } else {
            this.itemType = 'placeholder';
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

/**
 * Tree data provider for the index sidebar
 */
export class IndexTreeDataProvider implements vscode.TreeDataProvider<IndexTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IndexTreeItem | undefined | null | void> =
        new vscode.EventEmitter<IndexTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<IndexTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private indexingService: IndexingService;
    private vectorDbService: VectorDbService | null = null;
    private cachedEntries: Map<string, IndexEntry[]> = new Map();
    private cachedFolderTrees: Map<string, FolderTreeNode> = new Map();
    private groupByFolder: boolean = true;
    private showChunks: boolean = true;

    constructor(indexingService: IndexingService, vectorDbService?: VectorDbService) {
        this.indexingService = indexingService;
        this.vectorDbService = vectorDbService || null;

        // Refresh when indexing status changes
        this.indexingService.onStatusChange((status) => {
            if (!status.isIndexing) {
                this.clearCache();
                this.refresh();
            }
        });
    }

    setVectorDbService(service: VectorDbService): void {
        this.vectorDbService = service;
    }

    setGroupByFolder(enabled: boolean): void {
        this.groupByFolder = enabled;
        this.refresh();
    }

    setShowChunks(enabled: boolean): void {
        this.showChunks = enabled;
        this.refresh();
    }

    clearCache(): void {
        this.cachedEntries.clear();
        this.cachedFolderTrees.clear();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: IndexTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: IndexTreeItem): Promise<IndexTreeItem[]> {
        if (!element) {
            // Root level - show workspace folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return [
                    new IndexTreeItem(
                        'No workspace open',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }

            const items: IndexTreeItem[] = [];

            for (const folder of workspaceFolders) {
                try {
                    const workspacePath = normalizePath(folder.uri.fsPath);
                    console.log('IndexSidebar: Getting entries for workspace:', workspacePath);
                    const entries = await this.indexingService.getIndexEntries(workspacePath);
                    console.log('IndexSidebar: Got entries:', entries.length);
                    this.cachedEntries.set(workspacePath, entries);

                    const workspaceInfo: WorkspaceIndex = {
                        workspacePath,
                        totalFiles: entries.length,
                        totalChunks: entries.reduce((sum, e) => sum + e.chunkCount, 0),
                        lastUpdated: entries.length > 0
                            ? new Date(Math.max(...entries.map((e) => e.lastIndexedAt.getTime())))
                            : new Date(),
                    };

                    items.push(
                        new IndexTreeItem(
                            folder.name,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            undefined,
                            workspaceInfo
                        )
                    );
                } catch (error) {
                    console.error('IndexSidebar: Error getting index entries for workspace:', folder.name, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const item = new IndexTreeItem(
                        folder.name,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.description = 'Error loading';
                    item.tooltip = `Error: ${errorMessage}`;
                    items.push(item);
                }
            }

            return items;
        } else if (element.workspaceInfo) {
            // Workspace level - show folders or files
            let entries = this.cachedEntries.get(element.workspaceInfo.workspacePath);
            if (!entries) {
                entries = await this.indexingService.getIndexEntries(element.workspaceInfo.workspacePath);
                this.cachedEntries.set(element.workspaceInfo.workspacePath, entries);
            }

            if (entries.length === 0) {
                return [
                    new IndexTreeItem(
                        'No files indexed. Click "Build Index" to start.',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }

            if (this.groupByFolder) {
                // Build folder tree if not cached
                let folderTree = this.cachedFolderTrees.get(element.workspaceInfo.workspacePath);
                if (!folderTree) {
                    folderTree = buildFolderTree(entries);
                    this.cachedFolderTrees.set(element.workspaceInfo.workspacePath, folderTree);
                }
                
                const items: IndexTreeItem[] = [];
                
                // Show immediate child folders
                const childFolders = getImmediateChildFolders(folderTree, '');
                for (const folder of childFolders.sort((a, b) => a.name.localeCompare(b.name))) {
                    const item = new IndexTreeItem(
                        folder.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        undefined,
                        undefined,
                        folder.fullPath,
                        element.workspaceInfo.workspacePath
                    );
                    items.push(item);
                }
                
                // Show root-level files
                const rootFiles = getFilesInFolder(folderTree, '');
                for (const entry of rootFiles.sort((a, b) => path.basename(a.relativePath).localeCompare(path.basename(b.relativePath)))) {
                    items.push(new IndexTreeItem(
                        path.basename(entry.relativePath),
                        this.showChunks && entry.chunkCount > 0 
                            ? vscode.TreeItemCollapsibleState.Collapsed 
                            : vscode.TreeItemCollapsibleState.None,
                        entry
                    ));
                }
                
                return items;
            } else {
                // Flat list
                return entries
                    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
                    .map(entry => new IndexTreeItem(
                        entry.relativePath,
                        vscode.TreeItemCollapsibleState.None,
                        entry
                    ));
            }
        } else if (element.folderPath && element.workspacePath) {
            // Folder level - show subfolders and files in this folder
            let folderTree = this.cachedFolderTrees.get(element.workspacePath);
            if (!folderTree) {
                // Rebuild folder tree if not cached
                let entries = this.cachedEntries.get(element.workspacePath);
                if (!entries) {
                    entries = await this.indexingService.getIndexEntries(element.workspacePath);
                    this.cachedEntries.set(element.workspacePath, entries);
                }
                folderTree = buildFolderTree(entries);
                this.cachedFolderTrees.set(element.workspacePath, folderTree);
            }
            
            const items: IndexTreeItem[] = [];
            
            // Show child folders
            const childFolders = getImmediateChildFolders(folderTree, element.folderPath);
            for (const folder of childFolders.sort((a, b) => a.name.localeCompare(b.name))) {
                const item = new IndexTreeItem(
                    folder.name,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    undefined,
                    undefined,
                    folder.fullPath,
                    element.workspacePath
                );
                items.push(item);
            }
            
            // Show files directly in this folder
            const folderFiles = getFilesInFolder(folderTree, element.folderPath);
            for (const entry of folderFiles.sort((a, b) => path.basename(a.relativePath).localeCompare(path.basename(b.relativePath)))) {
                items.push(new IndexTreeItem(
                    path.basename(entry.relativePath),
                    this.showChunks && entry.chunkCount > 0 
                        ? vscode.TreeItemCollapsibleState.Collapsed 
                        : vscode.TreeItemCollapsibleState.None,
                    entry
                ));
            }
            
            return items;
        } else if (element.entry && this.showChunks && this.vectorDbService) {
            // File level - show chunks
            const chunks = await this.vectorDbService.getChunksForFile(element.entry.fileId);
            
            if (chunks.length === 0) {
                return [];
            }

            const fileUri = vscode.Uri.file(element.entry.filePath);
            
            return chunks.map((chunk, index) => new IndexTreeItem(
                `Chunk ${index + 1}`,
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                undefined,
                undefined,
                chunk,
                fileUri
            ));
        }

        return [];
    }
}

/**
 * Register the index sidebar view
 */
export function registerIndexSidebarView(
    context: vscode.ExtensionContext,
    indexingService: IndexingService,
    vectorDbService?: VectorDbService
): vscode.TreeView<IndexTreeItem> {
    const treeDataProvider = new IndexTreeDataProvider(indexingService, vectorDbService);

    const treeView = vscode.window.createTreeView('semanticSearchIndex', {
        treeDataProvider,
        showCollapseAll: true,
    });

    // Register refresh command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.refreshIndex', () => {
            treeDataProvider.clearCache();
            treeDataProvider.refresh();
        })
    );

    // Register toggle group by folder command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.toggleGroupByFolder', () => {
            const current = treeDataProvider['groupByFolder'];
            treeDataProvider.setGroupByFolder(!current);
        })
    );

    // Register toggle show chunks command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.toggleShowChunks', () => {
            const current = treeDataProvider['showChunks'];
            treeDataProvider.setShowChunks(!current);
        })
    );

    // Register reindex single file command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.reindexFile', async (item: IndexTreeItem) => {
            if (item?.entry) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(
                    vscode.Uri.file(item.entry.filePath)
                );
                if (workspaceFolder) {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Reindexing ${item.entry.relativePath}...`,
                        },
                        async () => {
                            await indexingService.indexFile(
                                vscode.Uri.file(item.entry!.filePath),
                                workspaceFolder.uri.fsPath
                            );
                            treeDataProvider.clearCache();
                            treeDataProvider.refresh();
                        }
                    );
                    vscode.window.showInformationMessage(`Reindexed ${item.entry.relativePath}`);
                }
            }
        })
    );

    // Register reindex folder command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.reindexFolder', async (item: IndexTreeItem) => {
            if (item?.folderPath && item?.workspacePath) {
                const entries = treeDataProvider['cachedEntries'].get(item.workspacePath) || [];
                const folderEntries = entries.filter(e => 
                    e.relativePath.startsWith(item.folderPath + '/') || 
                    e.relativePath.startsWith(item.folderPath + '\\')
                );
                
                if (folderEntries.length === 0) {
                    vscode.window.showInformationMessage(`No indexed files in folder ${item.folderPath}`);
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Reindexing folder ${item.folderPath}...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        let indexed = 0;
                        for (const entry of folderEntries) {
                            if (token.isCancellationRequested) {
                                break;
                            }
                            progress.report({ 
                                message: `${indexed + 1}/${folderEntries.length}: ${path.basename(entry.relativePath)}`,
                                increment: 100 / folderEntries.length 
                            });
                            await indexingService.indexFile(
                                vscode.Uri.file(entry.filePath),
                                item.workspacePath!
                            );
                            indexed++;
                        }
                        treeDataProvider.clearCache();
                        treeDataProvider.refresh();
                        vscode.window.showInformationMessage(`Reindexed ${indexed} files in ${item.folderPath}`);
                    }
                );
            }
        })
    );

    // Register delete folder index command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.deleteFolderIndex', async (item: IndexTreeItem) => {
            if (item?.folderPath && item?.workspacePath) {
                const entries = treeDataProvider['cachedEntries'].get(item.workspacePath) || [];
                const folderEntries = entries.filter(e => 
                    e.relativePath.startsWith(item.folderPath + '/') || 
                    e.relativePath.startsWith(item.folderPath + '\\')
                );
                
                if (folderEntries.length === 0) {
                    vscode.window.showInformationMessage(`No indexed files in folder ${item.folderPath}`);
                    return;
                }

                const confirm = await vscode.window.showWarningMessage(
                    `Delete index for ${folderEntries.length} files in folder ${item.folderPath}?`,
                    { modal: true },
                    'Delete'
                );

                if (confirm !== 'Delete') {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Deleting folder index ${item.folderPath}...`,
                    },
                    async () => {
                        for (const entry of folderEntries) {
                            await indexingService.deleteFileIndex(entry.filePath);
                        }
                        treeDataProvider.clearCache();
                        treeDataProvider.refresh();
                        vscode.window.showInformationMessage(`Deleted index for ${folderEntries.length} files in ${item.folderPath}`);
                    }
                );
            }
        })
    );

    // Register reindex workspace command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.reindexWorkspace', async (item: IndexTreeItem) => {
            if (item?.workspaceInfo) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.find(
                    f => normalizePath(f.uri.fsPath) === item.workspaceInfo!.workspacePath
                );
                
                if (workspaceFolder) {
                    await vscode.commands.executeCommand('semantic-search.buildIndex', workspaceFolder);
                    treeDataProvider.clearCache();
                    treeDataProvider.refresh();
                }
            }
        })
    );

    // Register delete workspace index command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.deleteWorkspaceIndex', async (item: IndexTreeItem) => {
            if (item?.workspaceInfo) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete entire index for workspace ${path.basename(item.workspaceInfo.workspacePath)}? This will remove ${item.workspaceInfo.totalFiles} indexed files.`,
                    { modal: true },
                    'Delete'
                );

                if (confirm !== 'Delete') {
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Deleting workspace index...`,
                    },
                    async () => {
                        await indexingService.deleteWorkspaceIndex(item.workspaceInfo!.workspacePath);
                        treeDataProvider.clearCache();
                        treeDataProvider.refresh();
                        vscode.window.showInformationMessage(`Workspace index deleted`);
                    }
                );
            }
        })
    );

    // Register reveal in explorer command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.revealInExplorer', async (item: IndexTreeItem) => {
            if (item?.entry) {
                const uri = vscode.Uri.file(item.entry.filePath);
                await vscode.commands.executeCommand('revealInExplorer', uri);
            }
        })
    );

    // Register copy path command
    context.subscriptions.push(
        vscode.commands.registerCommand('semantic-search.copyPath', async (item: IndexTreeItem) => {
            if (item?.entry) {
                await vscode.env.clipboard.writeText(item.entry.filePath);
                vscode.window.showInformationMessage('Path copied to clipboard');
            }
        })
    );

    return treeView;
}
