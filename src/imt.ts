import { Fr } from '@aztec/foundation/curves/bn254';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';

/**
 * Hash a ciphertext into a single leaf value using poseidon2.
 * Matches the circuit's computation in individual_note/src/main.nr
 */
async function hashCiphertextToLeaf(ciphertext: Buffer): Promise<Fr> {
    // Skip 32-byte tag (same as circuit)
    const ciphertextWithoutTag = ciphertext.slice(32);

    // Exactly 17 fields (MESSAGE_CIPHERTEXT_LEN)
    const MESSAGE_CIPHERTEXT_LEN = 17;
    const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
    ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

    const fields: Fr[] = [];
    for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
        const chunk = paddedBuffer.slice(i * 32, (i + 1) * 32);
        fields.push(Fr.fromBuffer(chunk));
    }

    // Use separator 0 (same as circuit)
    return await poseidon2HashWithSeparator(fields, 0);
}

/**
 * Build a binary incremental merkle tree from leaves.
 * Returns the root.
 *
 * - Pads to next power of 2 with Fr.ZERO
 * - Hashes pairs with poseidon2([left, right])
 */
async function buildIMT(leaves: Fr[]): Promise<Fr> {
    if (leaves.length === 0) {
        return Fr.ZERO;
    }

    // Pad to next power of 2
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < nextPow2) {
        paddedLeaves.push(Fr.ZERO);
    }

    // Build tree layer by layer
    let currentLevel = paddedLeaves;

    while (currentLevel.length > 1) {
        const nextLevel: Fr[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1];
            const parent = await poseidon2Hash([left, right]);
            nextLevel.push(parent);
        }
        currentLevel = nextLevel;
    }

    return currentLevel[0];
}

/**
 * Build IMT from ciphertexts.
 * Convenience function that hashes each ciphertext to a leaf, then builds tree.
 */
export async function buildIMTFromCiphertexts(ciphertexts: Buffer[]): Promise<Fr> {
    const leaves = await Promise.all(ciphertexts.map(c => hashCiphertextToLeaf(c)));
    return await buildIMT(leaves);
}

/**
 * Precomputed zero hashes for each level of a merkle tree.
 *
 * - zeroHashes[0] = Fr.ZERO (empty leaf)
 * - zeroHashes[1] = poseidon2Hash([zero_0, zero_0])
 * - zeroHashes[n] = poseidon2Hash([zero_{n-1}, zero_{n-1}])
 *
 * Useful for sparse merkle trees and padding empty subtrees.
 */
async function computeZeroHashes(maxDepth: number): Promise<Fr[]> {
    const zeroHashes: Fr[] = [Fr.ZERO];

    for (let i = 1; i <= maxDepth; i++) {
        const prev = zeroHashes[i - 1];
        const hash = await poseidon2Hash([prev, prev]);
        zeroHashes.push(hash);
    }

    return zeroHashes;
}

/**
 * Cached zero hashes - compute once and reuse.
 */
let cachedZeroHashes: Fr[] | null = null;
let cachedMaxDepth = 0;

/**
 * Get zero hashes up to a given depth, with caching.
 */
export async function getZeroHashes(maxDepth: number): Promise<Fr[]> {
    if (cachedZeroHashes && cachedMaxDepth >= maxDepth) {
        return cachedZeroHashes.slice(0, maxDepth + 1);
    }

    cachedZeroHashes = await computeZeroHashes(maxDepth);
    cachedMaxDepth = maxDepth;
    return cachedZeroHashes;
}

