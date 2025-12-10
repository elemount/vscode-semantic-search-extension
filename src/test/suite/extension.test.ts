import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		const extension = vscode.extensions.getExtension('undefined_publisher.semantic-search');
		assert.ok(extension, 'Extension should be found');
	});

	test('Extension should activate', async function() {
		this.timeout(30000); // Allow time for model loading
		
		const extension = vscode.extensions.getExtension('undefined_publisher.semantic-search');
		assert.ok(extension, 'Extension should be found');
		
		// Activate the extension if not already active
		if (!extension.isActive) {
			await extension.activate();
		}
		
		assert.ok(extension.isActive, 'Extension should be active');
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		
		const expectedCommands = [
			'semantic-search.buildIndex',
			'semantic-search.indexFiles',
			'semantic-search.search',
			'semantic-search.searchWithPanel',
			'semantic-search.quickSearch',
			'semantic-search.deleteIndex',
			'semantic-search.deleteFileIndex',
			'semantic-search.refreshIndex',
			'semantic-search.reindexFile',
			'semantic-search.toggleGroupByFolder',
			'semantic-search.focusSearchInput',
			'semantic-search.clearSearchResults',
			'semantic-search.openSearchInPanel',
		];
		
		for (const cmd of expectedCommands) {
			assert.ok(
				commands.includes(cmd),
				`Command ${cmd} should be registered`
			);
		}
	});

	test('Configuration should have default values', () => {
		const config = vscode.workspace.getConfiguration('semanticSearch');
		
		assert.strictEqual(config.get('autoIndex'), false);
		assert.strictEqual(config.get('indexing.chunkMaxTokens'), 1024);
		assert.strictEqual(config.get('indexing.chunkOverlapTokens'), 128);
		assert.strictEqual(config.get('maxResults'), 10);
		assert.strictEqual(config.get('logging.level'), 'warn');
	});
});
