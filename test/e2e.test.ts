import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { TokenContract } from '../src/artifacts';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import { sleep } from "bun";
import { retrieveEncryptedNotes } from "../src/auditor";
import { buildIMTFromCiphertexts } from "../src/imt";
import { ProofTree } from "../src/proof-tree";
import { Barretenberg } from '@aztec/bb.js';
import type { CompiledCircuit } from '@aztec/noir-types';

import individualNoteCircuit from '../circuits/individual_note/target/individual_note.json' with { type: 'json' };
import summaryTreeCircuit from '../circuits/note_summary_tree/target/note_summary_tree.json' with { type: 'json' };

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Private Transfer Demo Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token: TokenContract;
    let bb: Barretenberg;

    before(async () => {
        console.log("Initializing Barretenberg...");
        const threads = require('os').cpus().length;
        bb = await Barretenberg.new({ threads });
        console.log("Barretenberg initialized ✅");

        node = createAztecNodeClient(AZTEC_NODE_URL);
        console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false })

        const accounts = await getInitialTestAccountsData();
        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }

        token = await TokenContract.deployWithOpts(
            { wallet, method: "constructor_with_minter" },
            "USD Coin",
            "USDC",
            18,
            addresses[0],
            AztecAddress.ZERO
        ).send({ from: addresses[0] }).deployed();

        await token.methods.mint_to_private(addresses[1], precision(100n)).send({ from: addresses[0]}).wait();
        await token.methods.mint_to_private(addresses[2], precision(100n)).send({ from: addresses[0]}).wait();
    });

    test("generate tx activity", async () => {
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(4n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(6n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(8n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(1n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(10n), 0).send({ from: addresses[2] }).wait();
    });

    test("get notes to prove", async () => {
        await sleep(3000);

        console.log("\n=== STEP 1: Exporting Tagging Secrets ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        console.log("Exported tagging secrets:", taggingSecrets.secrets.length, "secrets");

        for (const secret of taggingSecrets.secrets) {
            console.log(`  Secret: counterparty: ${secret.counterparty.toString().slice(0, 16)}... app: ${secret.app.toString().slice(0, 16)}...`);
            console.log(`    Secret value: ${secret.secret.toString()}`);
        }

        console.log("\n=== STEP 2: Retrieving Encrypted Notes ===");
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        console.log("\n=== RETRIEVAL RESULTS ===");
        console.log(`Account: ${results.account}`);
        console.log(`Total Notes: ${results.totalNotes}`);
        console.log(`Total Transactions: ${results.totalTransactions}`);
        console.log(`Secrets Processed: ${results.secrets.length}`);

        for (const secretResult of results.secrets) {
            console.log(`\n--- Secret: ${secretResult.secret.counterparty.slice(0, 16)}... ---`);
            console.log(`  App: ${secretResult.secret.app.slice(0, 16)}...`);
            console.log(`  Notes Found: ${secretResult.noteCount}`);

            secretResult.notes.slice(0, 2).forEach((note, i) => {
                console.log(`\n  [${i + 1}] Note Hash: ${note.noteHash}`);
                console.log(`      Tx: ${note.txHash.slice(0, 16)}...`);
                console.log(`      Block: ${note.blockNumber}`);
                console.log(`      Ciphertext: ${note.ciphertextBytes} bytes`);
                console.log(`      Hex (first 64): ${note.ciphertext.slice(0, 64)}...`);
                console.log(`      Tag Index: ${note.tagIndex}`);
            });

            if (secretResult.noteCount > 2) {
                console.log(`  ... and ${secretResult.noteCount - 2} more notes`);
            }
        }

        expect(results.totalNotes).toBeGreaterThan(0);
        console.log("\n✓ Test complete - encrypted logs retrieved successfully!");
    });

    test("proof tree full aggregation", { timeout: 300000 }, async () => {
        await sleep(3000);

        console.log("\n=== STEP 1: Getting All Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        const pxe = wallet.pxe as any;
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);

        const allNotes = results.secrets.flatMap(s => s.notes);
        console.log(`Found ${allNotes.length} notes to prove`);

        console.log("\n=== STEP 2: Creating ProofTree ===");

        const tree = new ProofTree({
            bb,
            noteCircuit: individualNoteCircuit as CompiledCircuit,
            summaryCircuit: summaryTreeCircuit as CompiledCircuit,
            notes: allNotes.map(n => ({ ciphertext: Buffer.from(n.ciphertext, 'hex') })),
            recipientCompleteAddress,
            ivskM,
        });

        console.log("\n=== STEP 3: Generating Aggregated Proof ===");

        const result = await tree.prove();

        console.log(`\n=== FINAL RESULT ===`);
        console.log(`  Sum: ${result.publicInputs.sum / precision(1n)} tokens (${result.publicInputs.sum} raw)`);
        console.log(`  Root: ${result.publicInputs.root}`);
        console.log(`  VKey Hash: ${result.publicInputs.vkeyHash}`);
        console.log(`  Proof size: ${result.proof.length} bytes`);

        // Verify the sum matches expected (4 + 6 + 8 + 1 + 10 = 29 tokens)
        const expectedSum = 29n * precision(1n);
        expect(result.publicInputs.sum).toBe(expectedSum);

        // Verify the merkle root matches the IMT root computed by auditor
        const ciphertexts = allNotes.map(n => Buffer.from(n.ciphertext, 'hex'));
        const expectedRoot = await buildIMTFromCiphertexts(ciphertexts);
        expect(result.publicInputs.root).toBe(expectedRoot.toString());
        console.log(`  Merkle root matches auditor IMT: ✅`);

        console.log(`\n✓ ProofTree aggregation complete!`);
    });

});
