import { Fr } from '@aztec/foundation/curves/bn254';
import { Noir } from '@aztec/noir-noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';
import { decryptNote } from './decrypt';
import { getZeroHashes } from './imt';
import { computeAddressSecret } from '@aztec/stdlib/keys';

/**
 * Configuration for ProofTree
 */
export interface ProofTreeConfig {
    /** Barretenberg instance */
    bb: Barretenberg;
    /** Compiled individual_note circuit */
    noteCircuit: CompiledCircuit;
    /** Compiled note_summary_tree circuit */
    summaryCircuit: CompiledCircuit;
    /** Encrypted note ciphertexts */
    notes: { ciphertext: Buffer }[];
    /** Recipient's complete address */
    recipientCompleteAddress: any;
    /** Master incoming viewing secret key */
    ivskM: Fr;
}

/**
 * Result of proving the entire tree
 */
export interface ProofTreeResult {
    /** Final proof bytes */
    proof: Uint8Array;
    /** Public inputs from the final proof */
    publicInputs: {
        sum: bigint;
        root: string;
        vkeyHash: string;
    };
}

/**
 * Internal proof artifact for tree building
 */
interface ProofArtifact {
    proof: Uint8Array;
    proofAsFields: string[];
    publicInputs: string[]; // [value, tree_leaf, vkey_hash]
    value: bigint;
}

/**
 * ProofTree aggregates note proofs into a single recursive summary proof.
 *
 * Flow:
 * 1. Decrypt all notes and prove each one (leaf level)
 * 2. Pair proofs and combine with summary circuit
 * 3. Repeat until single proof remains
 */
export class ProofTree {
    private config: ProofTreeConfig;

    // Lazy-initialized components
    private noteNoir: Noir | null = null;
    private noteBackend: UltraHonkBackend | null = null;
    private summaryNoir: Noir | null = null;
    private summaryBackend: UltraHonkBackend | null = null;
    private addressSecret: Fr | null = null;
    private zeroHashes: Fr[] | null = null;

    // VKey artifacts (computed once)
    private leafVkAsFields: string[] | null = null;
    private leafVkHash: string | null = null;
    private summaryVkAsFields: string[] | null = null;
    private summaryVkHash: string | null = null;

    constructor(config: ProofTreeConfig) {
        this.config = config;
    }

    /**
     * Prove all notes and aggregate into a single summary proof.
     */
    async prove(): Promise<ProofTreeResult> {
        await this.initialize();

        console.log(`\n=== ProofTree: Starting proof generation for ${this.config.notes.length} notes ===`);

        // Step 1: Prove all leaves
        const leafProofs = await this.proveLeaves();
        console.log(`\nLeaf proofs generated: ${leafProofs.length}`);

        // Step 2: Build tree recursively
        const finalProof = await this.buildTree(leafProofs);
        console.log(`\nFinal proof generated!`);

        // Parse public inputs
        const [sumHex, rootHex, vkeyHashHex] = finalProof.publicInputs;

        return {
            proof: finalProof.proof,
            publicInputs: {
                sum: BigInt(sumHex),
                root: rootHex,
                vkeyHash: vkeyHashHex,
            },
        };
    }

    /**
     * Initialize all components (lazy)
     */
    private async initialize(): Promise<void> {
        if (this.noteNoir) return; // Already initialized

        console.log('Initializing ProofTree components...');

        // Initialize Noir instances
        this.noteNoir = new Noir(this.config.noteCircuit);
        await this.noteNoir.init();

        this.summaryNoir = new Noir(this.config.summaryCircuit);
        await this.summaryNoir.init();

        // Initialize backends
        this.noteBackend = new UltraHonkBackend(this.config.noteCircuit.bytecode, this.config.bb);
        this.summaryBackend = new UltraHonkBackend(this.config.summaryCircuit.bytecode, this.config.bb);

        // Compute address secret
        const preaddress = await this.config.recipientCompleteAddress.getPreaddress();
        this.addressSecret = await computeAddressSecret(preaddress, this.config.ivskM);

        // Precompute zero hashes (enough for any reasonable tree depth)
        this.zeroHashes = await getZeroHashes(20);

        console.log('ProofTree initialized ✅');
    }

    /**
     * Prove all individual notes (leaf level)
     */
    private async proveLeaves(): Promise<ProofArtifact[]> {
        const proofs: ProofArtifact[] = [];

        for (let i = 0; i < this.config.notes.length; i++) {
            const note = this.config.notes[i];
            console.log(`\n--- Proving leaf ${i + 1}/${this.config.notes.length} ---`);

            // Decrypt
            const plaintext = await decryptNote(
                note.ciphertext,
                this.config.recipientCompleteAddress,
                this.config.ivskM
            );
            if (!plaintext) {
                throw new Error(`Failed to decrypt note ${i}`);
            }

            // Prepare circuit inputs
            const circuitInputs = this.prepareNoteCircuitInputs(plaintext, note.ciphertext);

            // Generate witness
            const { witness, returnValue } = await this.noteNoir!.execute(circuitInputs);
            const [value, treeLeaf, vkeyHash] = returnValue as [string, string, string];

            // Generate proof with recursive target
            const proof = await this.noteBackend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
            const isValid = await this.noteBackend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
            if (!isValid) {
                throw new Error(`Invalid proof for note ${i}`);
            }

            // Get vkey artifacts (only once)
            if (!this.leafVkAsFields) {
                const artifacts = await this.noteBackend!.generateRecursiveProofArtifacts(proof.proof, 3);
                this.leafVkAsFields = artifacts.vkAsFields;
                this.leafVkHash = artifacts.vkHash;
            }

            // Convert proof to fields
            const proofAsFields = this.proofBytesToFields(proof.proof);

            const valueNum = BigInt(value);
            console.log(`  Value: ${valueNum / BigInt(1e18)} tokens`);
            console.log(`  Proof: ✅ Valid`);

            proofs.push({
                proof: proof.proof,
                proofAsFields,
                publicInputs: [value, treeLeaf, vkeyHash],
                value: valueNum,
            });
        }

        return proofs;
    }

    /**
     * Build the tree by recursively combining proofs
     */
    private async buildTree(proofs: ProofArtifact[]): Promise<ProofArtifact> {
        let currentLevel = proofs;
        let level = 0;

        while (currentLevel.length > 1) {
            console.log(`\n=== Building level ${level + 1} (${currentLevel.length} proofs → ${Math.ceil(currentLevel.length / 2)}) ===`);

            const nextLevel: ProofArtifact[] = [];

            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : null;

                console.log(`\n--- Combining pair ${Math.floor(i / 2) + 1} (${right ? 'full' : 'odd, using zero hash'}) ---`);

                const combined = await this.combineProofs(left, right, level);
                nextLevel.push(combined);
            }

            currentLevel = nextLevel;
            level++;
        }

        return currentLevel[0];
    }

    /**
     * Combine two proofs using the summary circuit
     */
    private async combineProofs(
        left: ProofArtifact,
        right: ProofArtifact | null,
        level: number
    ): Promise<ProofArtifact> {
        // Determine which vkey to use based on level
        const isLeafLevel = level === 0;
        let vkAsFields: string[];
        let vkHash: string;

        if (isLeafLevel) {
            vkAsFields = this.leafVkAsFields!;
            vkHash = this.leafVkHash!;
        } else {
            // For higher levels, use summary circuit vkey
            if (!this.summaryVkAsFields) {
                throw new Error('Summary vkey not yet computed - this should not happen');
            }
            vkAsFields = this.summaryVkAsFields;
            vkHash = this.summaryVkHash!;
        }

        // Prepare inputs
        const hasRight = right !== null;
        const emptyProof = new Array(left.proofAsFields.length).fill("0x0");
        const emptyPublicInputs = ["0x0", "0x0", "0x0"];
        const zeroLeafForLevel = this.zeroHashes![level];

        // For summary_vkey_hash: at level 0 we need to pre-compute it
        // We'll get it after the first summary proof, but we need it BEFORE
        // So we generate a throwaway proof first if we don't have it yet
        if (!this.summaryVkHash) {
            await this.precomputeSummaryVkHash(left, vkAsFields, vkHash);
        }

        const summaryInputs = {
            verification_key: vkAsFields,
            vkey_hash: vkHash,
            proof_left: left.proofAsFields,
            proof_right: {
                _is_some: hasRight,
                _value: hasRight ? right!.proofAsFields : emptyProof,
            },
            public_inputs_left: left.publicInputs,
            public_inputs_right: {
                _is_some: hasRight,
                _value: hasRight ? right!.publicInputs : emptyPublicInputs,
            },
            zero_leaf_hint: {
                _is_some: !hasRight,
                _value: hasRight ? "0x0" : zeroLeafForLevel.toString(),
            },
            summary_vkey_hash: this.summaryVkHash!,
        };

        // Execute summary circuit
        const { witness, returnValue } = await this.summaryNoir!.execute(summaryInputs);
        const [sum, root, outVkeyHash] = returnValue as [string, string, string];

        // Generate proof with recursive target (so it can be used in next level)
        const proof = await this.summaryBackend!.generateProof(witness, { verifierTarget: 'noir-recursive' });
        const isValid = await this.summaryBackend!.verifyProof(proof, { verifierTarget: 'noir-recursive' });
        if (!isValid) {
            throw new Error('Invalid summary proof');
        }

        // Get summary vkey artifacts (only once, after first summary proof)
        if (!this.summaryVkAsFields) {
            const artifacts = await this.summaryBackend!.generateRecursiveProofArtifacts(proof.proof, 3);
            this.summaryVkAsFields = artifacts.vkAsFields;
            this.summaryVkHash = artifacts.vkHash;
        }

        const proofAsFields = this.proofBytesToFields(proof.proof);
        const combinedValue = left.value + (right?.value ?? 0n);

        console.log(`  Combined sum: ${combinedValue / BigInt(1e18)} tokens`);
        console.log(`  Proof: ✅ Valid`);

        return {
            proof: proof.proof,
            proofAsFields,
            publicInputs: [sum, root, outVkeyHash],
            value: combinedValue,
        };
    }

    /**
     * Prepare inputs for the individual_note circuit
     */
    private prepareNoteCircuitInputs(
        plaintext: Fr[],
        encryptedLogBuffer: Buffer
    ): { plaintext: { storage: string[]; len: string }; ciphertext: string[]; ivsk_app: string } {
        // Convert plaintext to BoundedVec format
        const plaintextStorage = plaintext.map(f => f.toString());
        const plaintextLen = plaintextStorage.length;
        while (plaintextStorage.length < 14) {
            plaintextStorage.push("0");
        }

        // Parse ciphertext (skip 32-byte tag)
        const ciphertextWithoutTag = encryptedLogBuffer.slice(32);
        const MESSAGE_CIPHERTEXT_LEN = 17;
        const ciphertextFields: string[] = [];

        const paddedBuffer = Buffer.alloc(MESSAGE_CIPHERTEXT_LEN * 32);
        ciphertextWithoutTag.copy(paddedBuffer, 0, 0, Math.min(ciphertextWithoutTag.length, paddedBuffer.length));

        for (let i = 0; i < MESSAGE_CIPHERTEXT_LEN; i++) {
            const chunk = paddedBuffer.slice(i * 32, (i + 1) * 32);
            const field = Fr.fromBuffer(chunk);
            ciphertextFields.push(field.toString());
        }

        return {
            plaintext: {
                storage: plaintextStorage,
                len: plaintextLen.toString(),
            },
            ciphertext: ciphertextFields,
            ivsk_app: this.addressSecret!.toString(),
        };
    }

    /**
     * Convert proof bytes to field array (32 bytes per field)
     */
    private proofBytesToFields(proofBytes: Uint8Array): string[] {
        const fields: string[] = [];
        for (let i = 0; i < proofBytes.length; i += 32) {
            const chunk = proofBytes.slice(i, i + 32);
            const hex = '0x' + Buffer.from(chunk).toString('hex');
            fields.push(hex);
        }
        return fields;
    }

    /**
     * Pre-compute summary vkey hash by generating a throwaway proof.
     * This is needed because we need to pass summary_vkey_hash to level 0 proofs,
     * but we can only get it after generating a summary proof.
     */
    private async precomputeSummaryVkHash(
        sampleProof: ProofArtifact,
        vkAsFields: string[],
        vkHash: string
    ): Promise<void> {
        console.log('  Pre-computing summary vkey hash...');

        // Create minimal inputs with a placeholder summary_vkey_hash
        const emptyProof = new Array(sampleProof.proofAsFields.length).fill("0x0");
        const emptyPublicInputs = ["0x0", "0x0", "0x0"];

        const throwawayInputs = {
            verification_key: vkAsFields,
            vkey_hash: vkHash,
            proof_left: sampleProof.proofAsFields,
            proof_right: {
                _is_some: false,
                _value: emptyProof,
            },
            public_inputs_left: sampleProof.publicInputs,
            public_inputs_right: {
                _is_some: false,
                _value: emptyPublicInputs,
            },
            zero_leaf_hint: {
                _is_some: true,
                _value: this.zeroHashes![0].toString(),
            },
            summary_vkey_hash: "0x0", // Placeholder - not checked at level 0
        };

        // Generate throwaway proof
        const { witness } = await this.summaryNoir!.execute(throwawayInputs);
        const proof = await this.summaryBackend!.generateProof(witness, { verifierTarget: 'noir-recursive' });

        // Extract vkey artifacts
        const artifacts = await this.summaryBackend!.generateRecursiveProofArtifacts(proof.proof, 3);
        this.summaryVkAsFields = artifacts.vkAsFields;
        this.summaryVkHash = artifacts.vkHash;

        console.log(`  Summary vkey hash: ${this.summaryVkHash}`);
    }
}
