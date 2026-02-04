import type { AztecNode } from "@aztec/aztec.js/node";
import { TagGenerator, NoteMapper, type TaggingSecretExport, type TaggingSecretEntry } from "@aztec/note-collector";
import { createLogger } from "@aztec/foundation/log";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

/**
 * Retrieve encrypted note ciphertexts from the Aztec network using tagging secrets.
 *
 * Only processes INBOUND secrets - notes encrypted for the account holder.
 * Outbound notes (sent by the account) are encrypted for recipients and cannot
 * be decrypted by the sender.
 *
 * @param node - Aztec node client
 * @param secretsExport - Exported tagging secrets from a user
 * @param options - Scan options
 * @returns Results organized by tagging secret (inbound only)
 */
export async function retrieveEncryptedNotes(
    node: AztecNode,
    secretsExport: TaggingSecretExport,
    options?: {
        startIndex?: number;
        maxIndices?: number;
        batchSize?: number;
    }
): Promise<RetrievalResult> {
    const startIndex = options?.startIndex ?? 0;
    const maxIndices = options?.maxIndices ?? 10000;
    const batchSize = options?.batchSize ?? 100;

    const log = createLogger('auditor');
    const noteMapper = new NoteMapper(node, log);

    const results: SecretResult[] = [];
    const allTransactions = new Set<string>();

    // Filter to only inbound secrets - we can only decrypt notes encrypted for us
    const inboundSecrets = secretsExport.secrets.filter(s => s.direction === 'inbound');

    // Process each inbound secret
    for (const secretEntry of inboundSecrets) {
        const secretResult = await processSecret(
            node,
            secretEntry,
            noteMapper,
            startIndex,
            maxIndices,
            batchSize
        );

        results.push(secretResult);

        // Track unique transactions
        secretResult.notes.forEach(note => allTransactions.add(note.txHash));
    }

    return {
        account: secretsExport.account.toString(),
        retrievedAt: Date.now(),
        secrets: results,
        totalNotes: results.reduce((sum, r) => sum + r.notes.length, 0),
        totalTransactions: allTransactions.size,
    };
}

/**
 * Process a single tagging secret and retrieve all matching notes.
 */
async function processSecret(
    node: AztecNode,
    secretEntry: TaggingSecretEntry,
    noteMapper: NoteMapper,
    startIndex: number,
    maxIndices: number,
    batchSize: number
): Promise<SecretResult> {
    const notes: RetrievedNote[] = [];

    console.log(`[DEBUG] Processing secret: counterparty: ${secretEntry.counterparty.toString().slice(0, 16)}...`);

    // Scan in batches
    for (let index = startIndex; index < startIndex + maxIndices; index += batchSize) {
        const count = Math.min(batchSize, startIndex + maxIndices - index);

        // Generate siloed tags for this batch (TWO-STEP PROCESS)
        // Step 1: Generate base tags (unsiloed)
        const baseTags = await TagGenerator.generateTags(secretEntry.secret, index, count);

        // Step 2: Silo each tag with the contract address
        // Formula: siloedTag = poseidon2Hash([contractAddress, baseTag])
        // This matches what the PXE does: SiloedTag.compute(Tag.compute(preTag), contractAddress)
        const siloedTags = await Promise.all(
            baseTags.map(async baseTag => {
                return await poseidon2Hash([secretEntry.app, baseTag]);
            })
        );

        console.log(`[DEBUG] Generated ${siloedTags.length} siloed tags for indices ${index}-${index + count - 1}`);
        console.log(`[DEBUG] First siloed tag: ${siloedTags[0].toString()}`);

        // Query logs by siloed tags
        const logsPerTag = await node.getLogsByTags(siloedTags);

        const totalLogs = logsPerTag.reduce((sum, logs) => sum + logs.length, 0);
        console.log(`[DEBUG] Received ${totalLogs} logs from node`);

        // Process each tag's logs
        for (let i = 0; i < logsPerTag.length; i++) {
            const logs = logsPerTag[i];
            if (logs.length === 0) continue;

            // Map logs to note hashes
            const mappings = await noteMapper.mapLogsToNoteHashes(
                logs,
                secretEntry.direction,
                secretEntry.counterparty,
                secretEntry.app
            );

            // Convert to retrieval format
            for (const mapping of mappings) {
                notes.push({
                    txHash: mapping.txHash.toString(),
                    blockNumber: mapping.blockNumber.toString(),
                    noteHash: mapping.noteHash.toString(),
                    ciphertext: mapping.encryptedLog.toString('hex'),
                    ciphertextBytes: mapping.encryptedLog.length,
                    logIndex: mapping.logIndexInTx,
                    treeIndex: mapping.dataStartIndexForTx,
                    tagIndex: index + i,
                });
            }
        }

        // If we found no logs in this batch, we might be done
        if (logsPerTag.every(logs => logs.length === 0)) {
            break;
        }
    }

    return {
        secret: {
            counterparty: secretEntry.counterparty.toString(),
            app: secretEntry.app.toString(),
            label: secretEntry.label,
        },
        notes,
        noteCount: notes.length,
    };
}

/**
 * Result of retrieving encrypted notes.
 */
export interface RetrievalResult {
    /** Account these notes belong to */
    account: string;
    /** When the retrieval was performed */
    retrievedAt: number;
    /** Results organized by tagging secret */
    secrets: SecretResult[];
    /** Total number of notes found across all secrets */
    totalNotes: number;
    /** Total number of unique transactions */
    totalTransactions: number;
}

/**
 * Notes retrieved using a specific tagging secret.
 */
export interface SecretResult {
    /** Metadata about the tagging secret */
    secret: {
        counterparty: string;
        app: string;
        label?: string;
    };
    /** All notes found with this secret */
    notes: RetrievedNote[];
    /** Number of notes found */
    noteCount: number;
}

/**
 * A single retrieved note with its encrypted ciphertext.
 */
export interface RetrievedNote {
    /** Transaction hash containing this note */
    txHash: string;
    /** Block number */
    blockNumber: string;
    /** Note hash (public commitment) */
    noteHash: string;
    /** Encrypted log ciphertext (hex encoded) */
    ciphertext: string;
    /** Size of ciphertext in bytes */
    ciphertextBytes: number;
    /** Index of this log within the transaction */
    logIndex: number;
    /** Starting index in the note hash tree */
    treeIndex: number;
    /** Tag index that discovered this note */
    tagIndex: number;
}

