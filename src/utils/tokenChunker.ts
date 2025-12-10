import { DEFAULT_INDEXING_CONFIG, IndexingConfig } from '../models/types';

let encoding: any | null = null;

function getEncoding() {
    if (encoding) {
        return encoding;
    }

    // js-tiktoken provides getEncoding to construct a tokenizer
    // We use cl100k_base which is a good general-purpose BPE
    const { getEncoding } = require('js-tiktoken');
    encoding = getEncoding('cl100k_base');
    return encoding;
}

export interface TokenChunk {
    content: string;
    lineStart: number;
    lineEnd: number;
    tokenStart: number;
    tokenEnd: number;
}

/**
 * Boundary types for code chunking, ordered by priority (higher = better break point)
 */
enum BoundaryType {
    None = 0,
    // Low priority - minor boundaries
    SingleLineComment = 1,    // // comment
    Semicolon = 2,            // end of statement
    CloseBrace = 3,           // } end of block
    
    // Medium priority - logical boundaries
    BlankLine = 4,            // empty line
    MultiLineCommentEnd = 5,  // */ end of block comment
    
    // High priority - major boundaries
    DoubleBlankLine = 6,      // two consecutive blank lines
    FunctionEnd = 7,          // } after function/class
    ImportBlockEnd = 8,       // end of import section
}

/**
 * Analyze a line and determine its boundary type
 */
function getBoundaryType(line: string, prevLine: string | null, nextLine: string | null): BoundaryType {
    const trimmed = line.trim();
    const prevTrimmed = prevLine?.trim() ?? '';
    const nextTrimmed = nextLine?.trim() ?? '';
    
    // Double blank line (current and previous are both empty)
    if (trimmed === '' && prevTrimmed === '') {
        return BoundaryType.DoubleBlankLine;
    }
    
    // End of import block (current is import, next is not import and not blank)
    if ((trimmed.startsWith('import ') || trimmed.startsWith('from ')) && 
        nextTrimmed !== '' && 
        !nextTrimmed.startsWith('import ') && 
        !nextTrimmed.startsWith('from ')) {
        return BoundaryType.ImportBlockEnd;
    }
    
    // Function/class end: closing brace followed by blank line or another definition
    if (trimmed === '}' || trimmed === '};') {
        if (nextTrimmed === '' || 
            nextTrimmed.startsWith('function ') || 
            nextTrimmed.startsWith('class ') ||
            nextTrimmed.startsWith('export ') ||
            nextTrimmed.startsWith('const ') ||
            nextTrimmed.startsWith('async ') ||
            nextTrimmed.startsWith('def ') ||
            nextTrimmed.startsWith('public ') ||
            nextTrimmed.startsWith('private ') ||
            nextTrimmed.startsWith('@')) {
            return BoundaryType.FunctionEnd;
        }
        return BoundaryType.CloseBrace;
    }
    
    // Blank line
    if (trimmed === '') {
        return BoundaryType.BlankLine;
    }
    
    // End of multi-line comment
    if (trimmed.endsWith('*/')) {
        return BoundaryType.MultiLineCommentEnd;
    }
    
    // Single line comment (entire line is a comment)
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        return BoundaryType.SingleLineComment;
    }
    
    // Statement ending with semicolon
    if (trimmed.endsWith(';')) {
        return BoundaryType.Semicolon;
    }
    
    return BoundaryType.None;
}

/**
 * Find the best boundary line within a range
 * Prefers boundaries closer to the end of the range with higher boundary types
 */
function findBestBoundary(
    lines: string[],
    searchStart: number,  // Start searching from this line (inclusive)
    searchEnd: number,    // End searching at this line (exclusive)
    minBoundaryType: BoundaryType = BoundaryType.Semicolon
): number | null {
    let bestLine: number | null = null;
    let bestType: BoundaryType = BoundaryType.None;
    
    // Search from the end backwards to prefer later boundaries
    for (let i = searchEnd - 1; i >= searchStart; i--) {
        const prevLine = i > 0 ? lines[i - 1] : null;
        const nextLine = i < lines.length - 1 ? lines[i + 1] : null;
        const boundaryType = getBoundaryType(lines[i], prevLine, nextLine);
        
        // Accept this boundary if it's better than what we have
        // Or if it's high priority (FunctionEnd, ImportBlockEnd, DoubleBlankLine)
        if (boundaryType >= minBoundaryType) {
            if (boundaryType >= BoundaryType.FunctionEnd) {
                // High priority boundaries - take immediately
                return i;
            }
            if (boundaryType > bestType || 
                (boundaryType === bestType && bestLine === null)) {
                bestType = boundaryType;
                bestLine = i;
            }
        }
    }
    
    return bestLine;
}

/**
 * Split content into chunks using sliding window with semantic boundaries
 * 
 * Strategy:
 * 1. Expand window until we hit token/line limits
 * 2. Look back for a good semantic boundary to end the chunk
 * 3. Start next chunk with minimal overlap at a good boundary
 */
export function splitIntoTokenChunks(
    content: string,
    config: IndexingConfig = DEFAULT_INDEXING_CONFIG
): TokenChunk[] {
    const enc = getEncoding();

    const lines = content.split('\n');
    const tokenStarts: number[] = new Array(lines.length);
    const tokenEnds: number[] = new Array(lines.length);

    let totalTokens = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineTokens = enc.encode(lines[i] ?? '');
        tokenStarts[i] = totalTokens;
        totalTokens += lineTokens.length;
        tokenEnds[i] = totalTokens;
    }

    if (lines.length === 0) {
        return [];
    }

    const maxTokensRaw =
        typeof config.chunkMaxTokens === 'number'
            ? config.chunkMaxTokens
            : DEFAULT_INDEXING_CONFIG.chunkMaxTokens;
    const maxLineRaw =
        typeof config.chunkMaxLine === 'number'
            ? config.chunkMaxLine
            : DEFAULT_INDEXING_CONFIG.chunkMaxLine;
    const overlapTokensRaw =
        typeof config.chunkOverlapTokens === 'number'
            ? config.chunkOverlapTokens
            : DEFAULT_INDEXING_CONFIG.chunkOverlapTokens;

    const maxTokens = Math.min(Math.max(maxTokensRaw, 256), 2048);
    const maxLine = Math.min(Math.max(maxLineRaw, 10), 200);
    const overlapTokens = Math.max(0, Math.min(overlapTokensRaw, maxTokens - 1));

    // If entire content fits in one chunk, return it
    if (totalTokens <= maxTokens && lines.length <= maxLine) {
        return [
            {
                content,
                lineStart: 1,
                lineEnd: lines.length,
                tokenStart: 0,
                tokenEnd: totalTokens,
            },
        ];
    }

    const chunks: TokenChunk[] = [];
    let startLine = 0;

    while (startLine < lines.length) {
        const chunkTokenStart = tokenStarts[startLine];
        
        // Step 1: Find the maximum extent of this chunk
        let maxEndLine = startLine + 1;
        while (maxEndLine < lines.length) {
            const candidateTokenEnd = tokenEnds[maxEndLine];
            const candidateTokenCount = candidateTokenEnd - chunkTokenStart;
            const candidateLineCount = maxEndLine - startLine + 1;

            if (candidateTokenCount > maxTokens || candidateLineCount > maxLine) {
                break;
            }
            maxEndLine++;
        }

        // Step 2: Look for a good boundary to end the chunk
        // Search in the last 30% of the chunk for a boundary
        const searchStart = Math.max(startLine, Math.floor(maxEndLine - (maxEndLine - startLine) * 0.3));
        let endLine = findBestBoundary(lines, searchStart, maxEndLine) ?? (maxEndLine - 1);
        
        // Ensure we include at least the found boundary line
        endLine = Math.max(startLine, endLine);
        const endLineExclusive = endLine + 1;

        // Step 3: Create the chunk
        const tokenEnd = tokenEnds[endLine];
        const chunkLines = lines.slice(startLine, endLineExclusive);

        chunks.push({
            content: chunkLines.join('\n'),
            lineStart: startLine + 1,  // 1-based
            lineEnd: endLineExclusive,  // 1-based, inclusive of last line
            tokenStart: chunkTokenStart,
            tokenEnd,
        });

        // Step 4: Determine where to start the next chunk
        if (endLineExclusive >= lines.length) {
            break;
        }

        // For overlap, look for a good starting boundary
        let nextStartLine: number;
        
        if (overlapTokens <= 0) {
            // No overlap requested
            nextStartLine = endLineExclusive;
        } else {
            // Calculate desired overlap start based on tokens
            const desiredOverlapStartToken = Math.max(
                chunkTokenStart,
                tokenEnd - overlapTokens
            );

            // Find the line where this token position falls
            let overlapStartLine = endLine;
            for (let i = startLine + 1; i <= endLine; i++) {
                if (tokenStarts[i] >= desiredOverlapStartToken) {
                    overlapStartLine = i;
                    break;
                }
            }

            // Limit overlap to at most 25% of maxLine
            const maxOverlapLines = Math.max(1, Math.floor(maxLine * 0.25));
            const minNextStartLine = endLineExclusive - maxOverlapLines;
            overlapStartLine = Math.max(overlapStartLine, minNextStartLine);

            // Try to find a good boundary near the overlap start point
            // Look in a small window around the desired start
            const boundarySearchStart = Math.max(startLine + 1, overlapStartLine - 3);
            const boundarySearchEnd = Math.min(endLineExclusive, overlapStartLine + 3);
            
            const boundaryLine = findBestBoundary(lines, boundarySearchStart, boundarySearchEnd, BoundaryType.BlankLine);
            
            if (boundaryLine !== null && boundaryLine > startLine) {
                // Start after the boundary (e.g., after a blank line)
                nextStartLine = boundaryLine + 1;
            } else {
                nextStartLine = overlapStartLine;
            }
        }

        // Ensure we make progress
        if (nextStartLine <= startLine) {
            nextStartLine = startLine + 1;
        }

        startLine = nextStartLine;
    }

    return chunks;
}

/**
 * Document-specific configuration
 */
const DOC_CONFIG = {
    maxTokens: 256,
    maxLine: 8,
    overlapTokens: 64,        // Smaller overlap for documents
    overlapLines: 2,          // Max 2 lines overlap for documents
    // Code blocks can be larger
    codeBlockMaxTokens: 512,
    codeBlockMaxLine: 30,
};

/**
 * Boundary types for document chunking
 */
enum DocBoundaryType {
    None = 0,
    ListItem = 1,           // - or * or 1.
    Paragraph = 2,          // blank line between paragraphs
    CodeBlockEnd = 3,       // ``` end of code block
    HorizontalRule = 4,     // --- or ***
    Heading = 5,            // # ## ### etc
}

/**
 * Detect if a line is a code block fence
 */
function isCodeFence(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

/**
 * Get document boundary type
 */
function getDocBoundaryType(line: string, prevLine: string | null): DocBoundaryType {
    const trimmed = line.trim();
    const prevTrimmed = prevLine?.trim() ?? '';
    
    // Heading (# ## ### etc)
    if (/^#{1,6}\s/.test(trimmed)) {
        return DocBoundaryType.Heading;
    }
    
    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        return DocBoundaryType.HorizontalRule;
    }
    
    // Code block end
    if (isCodeFence(trimmed) && prevTrimmed !== '') {
        return DocBoundaryType.CodeBlockEnd;
    }
    
    // Blank line (paragraph break)
    if (trimmed === '' && prevTrimmed !== '') {
        return DocBoundaryType.Paragraph;
    }
    
    // List item
    if (/^[-*+]\s|^\d+\.\s/.test(trimmed)) {
        return DocBoundaryType.ListItem;
    }
    
    return DocBoundaryType.None;
}

/**
 * Find code block ranges in the document
 * Returns array of [startLine, endLine] (inclusive, 0-based)
 */
function findCodeBlocks(lines: string[]): Array<[number, number]> {
    const blocks: Array<[number, number]> = [];
    let inCodeBlock = false;
    let blockStart = -1;
    
    for (let i = 0; i < lines.length; i++) {
        if (isCodeFence(lines[i])) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                blockStart = i;
            } else {
                inCodeBlock = false;
                blocks.push([blockStart, i]);
            }
        }
    }
    
    // Handle unclosed code block
    if (inCodeBlock && blockStart >= 0) {
        blocks.push([blockStart, lines.length - 1]);
    }
    
    return blocks;
}

/**
 * Check if a line is inside a code block
 */
function isInCodeBlock(lineIndex: number, codeBlocks: Array<[number, number]>): [number, number] | null {
    for (const [start, end] of codeBlocks) {
        if (lineIndex >= start && lineIndex <= end) {
            return [start, end];
        }
    }
    return null;
}

/**
 * Find best document boundary within a range
 */
function findDocBoundary(
    lines: string[],
    searchStart: number,
    searchEnd: number,
    codeBlocks: Array<[number, number]>
): number | null {
    let bestLine: number | null = null;
    let bestType: DocBoundaryType = DocBoundaryType.None;
    
    for (let i = searchEnd - 1; i >= searchStart; i--) {
        // Skip if inside code block
        if (isInCodeBlock(i, codeBlocks)) {
            continue;
        }
        
        const prevLine = i > 0 ? lines[i - 1] : null;
        const boundaryType = getDocBoundaryType(lines[i], prevLine);
        
        if (boundaryType >= DocBoundaryType.Heading) {
            // High priority - break before heading
            return i > 0 ? i - 1 : i;
        }
        
        if (boundaryType > bestType) {
            bestType = boundaryType;
            bestLine = i;
        }
    }
    
    return bestLine;
}

/**
 * Split document content into chunks with special handling for code blocks
 * 
 * Strategy:
 * 1. Use smaller chunks for prose (256 tokens, 8 lines)
 * 2. Keep code blocks intact when possible (up to 512 tokens, 30 lines)
 * 3. Break at semantic boundaries (headings, paragraphs, code block ends)
 */
export function splitDocumentIntoChunks(
    content: string,
    config: IndexingConfig = DEFAULT_INDEXING_CONFIG
): TokenChunk[] {
    const enc = getEncoding();
    const lines = content.split('\n');
    
    if (lines.length === 0) {
        return [];
    }

    // Pre-compute token positions
    const tokenStarts: number[] = new Array(lines.length);
    const tokenEnds: number[] = new Array(lines.length);
    let totalTokens = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const lineTokens = enc.encode(lines[i] ?? '');
        tokenStarts[i] = totalTokens;
        totalTokens += lineTokens.length;
        tokenEnds[i] = totalTokens;
    }

    // Find all code blocks
    const codeBlocks = findCodeBlocks(lines);
    
    // If entire content is small enough, return as single chunk
    if (totalTokens <= DOC_CONFIG.maxTokens && lines.length <= DOC_CONFIG.maxLine) {
        return [{
            content,
            lineStart: 1,
            lineEnd: lines.length,
            tokenStart: 0,
            tokenEnd: totalTokens,
        }];
    }

    const chunks: TokenChunk[] = [];
    let startLine = 0;

    while (startLine < lines.length) {
        const chunkTokenStart = tokenStarts[startLine];
        
        // Check if we're starting inside a code block
        const codeBlock = isInCodeBlock(startLine, codeBlocks);
        
        let maxTokens: number;
        let maxLine: number;
        let forceEndLine: number | null = null;
        
        if (codeBlock) {
            // Inside code block - use larger limits and try to include entire block
            maxTokens = DOC_CONFIG.codeBlockMaxTokens;
            maxLine = DOC_CONFIG.codeBlockMaxLine;
            
            const [, blockEnd] = codeBlock;
            const blockTokens = tokenEnds[blockEnd] - chunkTokenStart;
            const blockLines = blockEnd - startLine + 1;
            
            // If code block fits, include it entirely
            if (blockTokens <= maxTokens && blockLines <= maxLine) {
                forceEndLine = blockEnd;
            }
        } else {
            // Normal prose - use smaller limits
            maxTokens = DOC_CONFIG.maxTokens;
            maxLine = DOC_CONFIG.maxLine;
        }

        // Find maximum extent of this chunk
        let maxEndLine = startLine + 1;
        
        if (forceEndLine !== null) {
            maxEndLine = forceEndLine + 1;
        } else {
            while (maxEndLine < lines.length) {
                const candidateTokenEnd = tokenEnds[maxEndLine];
                const candidateTokenCount = candidateTokenEnd - chunkTokenStart;
                const candidateLineCount = maxEndLine - startLine + 1;

                if (candidateTokenCount > maxTokens || candidateLineCount > maxLine) {
                    break;
                }
                
                // Check if next line would start a code block we can't fit
                const nextCodeBlock = isInCodeBlock(maxEndLine, codeBlocks);
                if (nextCodeBlock && nextCodeBlock[0] === maxEndLine) {
                    // Starting a new code block - check if we can include it
                    const [blockStart, blockEnd] = nextCodeBlock;
                    const blockTokens = tokenEnds[blockEnd] - tokenStarts[blockStart];
                    const remainingTokens = maxTokens - (tokenEnds[maxEndLine - 1] - chunkTokenStart);
                    
                    if (blockTokens > remainingTokens) {
                        // Code block won't fit - end chunk here
                        break;
                    }
                }
                
                maxEndLine++;
            }
        }

        // Look for a good boundary to end the chunk
        let endLine: number;
        
        if (forceEndLine !== null) {
            endLine = forceEndLine;
        } else {
            const searchStart = Math.max(startLine, Math.floor(maxEndLine - (maxEndLine - startLine) * 0.4));
            const boundaryLine = findDocBoundary(lines, searchStart, maxEndLine, codeBlocks);
            endLine = boundaryLine ?? (maxEndLine - 1);
        }
        
        endLine = Math.max(startLine, endLine);
        const endLineExclusive = endLine + 1;

        // Create the chunk
        const tokenEnd = tokenEnds[endLine];
        const chunkLines = lines.slice(startLine, endLineExclusive);

        chunks.push({
            content: chunkLines.join('\n'),
            lineStart: startLine + 1,
            lineEnd: endLineExclusive,
            tokenStart: chunkTokenStart,
            tokenEnd,
        });

        if (endLineExclusive >= lines.length) {
            break;
        }

        // Determine next start line with overlap for documents
        let nextStartLine: number;
        
        // Check if current chunk ended inside or just after a code block
        const endedInCodeBlock = isInCodeBlock(endLine, codeBlocks);
        
        if (endedInCodeBlock) {
            // After code block - no overlap, start fresh
            nextStartLine = endLineExclusive;
        } else {
            // Normal prose - apply overlap
            const tokenEnd = tokenEnds[endLine];
            const desiredOverlapStartToken = Math.max(
                chunkTokenStart,
                tokenEnd - DOC_CONFIG.overlapTokens
            );

            // Find the line where overlap should start
            let overlapStartLine = endLine;
            for (let i = startLine + 1; i <= endLine; i++) {
                if (tokenStarts[i] >= desiredOverlapStartToken) {
                    overlapStartLine = i;
                    break;
                }
            }

            // Limit overlap to max lines
            const minNextStartLine = endLineExclusive - DOC_CONFIG.overlapLines;
            overlapStartLine = Math.max(overlapStartLine, minNextStartLine);

            // Don't overlap into code blocks
            const overlapCodeBlock = isInCodeBlock(overlapStartLine, codeBlocks);
            if (overlapCodeBlock) {
                // Start after the code block instead
                nextStartLine = overlapCodeBlock[1] + 1;
            } else {
                nextStartLine = overlapStartLine;
            }
        }
        
        // Skip leading blank lines (but keep some context)
        let blankCount = 0;
        while (nextStartLine < lines.length && 
               lines[nextStartLine].trim() === '' && 
               blankCount < 1) {
            nextStartLine++;
            blankCount++;
        }

        if (nextStartLine <= startLine) {
            nextStartLine = startLine + 1;
        }

        startLine = nextStartLine;
    }

    return chunks;
}

/**
 * Check if a file is a document type based on extension
 */
export function isDocumentFile(filePath: string): boolean {
    const ext = filePath.toLowerCase().split('.').pop() ?? '';
    const docExtensions = ['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc'];
    return docExtensions.includes(ext);
}

/**
 * Smart chunking that auto-detects file type
 */
export function smartChunk(
    content: string,
    filePath: string,
    config: IndexingConfig = DEFAULT_INDEXING_CONFIG
): TokenChunk[] {
    if (isDocumentFile(filePath)) {
        return splitDocumentIntoChunks(content, config);
    }
    return splitIntoTokenChunks(content, config);
}