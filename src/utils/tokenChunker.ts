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

    if (totalTokens <= maxTokens) {
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
        let endLineExclusive = startLine + 1;

        while (endLineExclusive <= lines.length) {
            const lastLineIndex = endLineExclusive - 1;
            const candidateTokenEnd = tokenEnds[lastLineIndex];
            const candidateTokenCount = candidateTokenEnd - chunkTokenStart;
            const candidateLineCount = endLineExclusive - startLine;

            // Check if we've exceeded either limit
            const exceedsTokenLimit = candidateTokenCount > maxTokens;
            const exceedsLineLimit = candidateLineCount > maxLine;

            if ((exceedsTokenLimit || exceedsLineLimit) && endLineExclusive > startLine + 1) {
                endLineExclusive--;
                break;
            }

            if (exceedsTokenLimit || exceedsLineLimit) {
                break;
            }

            endLineExclusive++;
        }

        if (endLineExclusive > lines.length) {
            endLineExclusive = lines.length;
        }

        if (endLineExclusive <= startLine) {
            endLineExclusive = Math.min(startLine + 1, lines.length);
        }

        const lastLineIndex = endLineExclusive - 1;
        const tokenEnd = tokenEnds[lastLineIndex];
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

        if (overlapTokens <= 0) {
            startLine = endLineExclusive;
            continue;
        }

        const desiredOverlapStartToken = Math.max(
            chunkTokenStart,
            tokenEnd - overlapTokens
        );

        let nextStartLine = endLineExclusive - 1;
        for (let i = startLine + 1; i < endLineExclusive; i++) {
            if (tokenStarts[i] >= desiredOverlapStartToken) {
                nextStartLine = i;
                break;
            }
        }

        if (nextStartLine <= startLine) {
            nextStartLine = startLine + 1;
        }

        startLine = nextStartLine;
    }

    return chunks;
}
