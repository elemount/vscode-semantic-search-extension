/**
 * Template loader utility for loading HTML and CSS templates
 */

import * as vscode from 'vscode';

const templateCache: Map<string, string> = new Map();

/**
 * Load a template file from the templates directory
 */
export async function loadTemplate(extensionUri: vscode.Uri, templateName: string): Promise<string> {
    const cacheKey = `template:${templateName}`;
    
    if (templateCache.has(cacheKey)) {
        return templateCache.get(cacheKey)!;
    }
    
    const templatePath = vscode.Uri.joinPath(extensionUri, 'out', 'views', 'templates', templateName);
    const content = await vscode.workspace.fs.readFile(templatePath);
    const templateContent = Buffer.from(content).toString('utf-8');
    
    templateCache.set(cacheKey, templateContent);
    return templateContent;
}

/**
 * Load a CSS file from the templates directory
 */
export async function loadCss(extensionUri: vscode.Uri, cssName: string): Promise<string> {
    const cacheKey = `css:${cssName}`;
    
    if (templateCache.has(cacheKey)) {
        return templateCache.get(cacheKey)!;
    }
    
    const cssPath = vscode.Uri.joinPath(extensionUri, 'out', 'views', 'templates', cssName);
    const content = await vscode.workspace.fs.readFile(cssPath);
    const cssContent = Buffer.from(content).toString('utf-8');
    
    templateCache.set(cacheKey, cssContent);
    return cssContent;
}

/**
 * Clear the template cache (useful for development)
 */
export function clearTemplateCache(): void {
    templateCache.clear();
}
