/**
 * Embedding Service - Uses Transformers.js for embedding generation
 * Uses onnx-community/embeddinggemma-300m-ONNX model (768 dimensions)
 */

import * as vscode from 'vscode';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pipeline = any;

export interface EmbeddingProgress {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
}

export class EmbeddingService {
    private extractor: Pipeline | null = null;
    private modelId = 'onnx-community/embeddinggemma-300m-ONNX';
    private dimensions = 768;
    private initPromise: Promise<void> | null = null;
    
    constructor(private context: vscode.ExtensionContext) {}
    
    /**
     * Initialize the embedding model using pipeline
     */
    async initialize(
        onProgress?: (progress: EmbeddingProgress) => void
    ): Promise<void> {
        if (this.extractor) {
            return;
        }
        if (this.initPromise) {
            return this.initPromise;
        }
        
        this.initPromise = this.loadModel(onProgress);
        await this.initPromise;
    }
    
    private async loadModel(
        onProgress?: (progress: EmbeddingProgress) => void
    ): Promise<void> {
        const { pipeline } = await import('@huggingface/transformers');
        
        // Custom cache directory in extension storage
        const cacheDir = path.join(
            this.context.globalStorageUri.fsPath,
            'models'
        );
        
        // Use feature-extraction pipeline which handles pooling automatically
        this.extractor = await pipeline('feature-extraction', this.modelId, {
            dtype: 'q4',  // Use smallest quantized model
            cache_dir: cacheDir,
            progress_callback: onProgress
        });
    }
    
    /**
     * Generate embedding for a single text
     */
    async embed(text: string): Promise<number[]> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }
    
    /**
     * Generate embeddings for multiple texts
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        if (!this.extractor) {
            throw new Error('EmbeddingService not initialized');
        }
        
        if (texts.length === 0) {
            return [];
        }
        
        const results: number[][] = [];
        
        // Process each text through the pipeline
        for (const text of texts) {
            const output = await this.extractor(text, { 
                pooling: 'mean', 
                normalize: true 
            });
            // Output is a Tensor, convert to array
            results.push(Array.from(output.data));
        }
        
        return results;
    }
    
    /**
     * Get embedding dimensions
     */
    getDimensions(): number {
        return this.dimensions;
    }
    
    /**
     * Get model name
     */
    getModelId(): string {
        return this.modelId;
    }
    
    /**
     * Check if service is initialized
     */
    isInitialized(): boolean {
        return this.extractor !== null;
    }
}
