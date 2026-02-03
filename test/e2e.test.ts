import { before, describe, test } from "node:test";
import { expect } from '@jest/globals';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
// import { TestWallet } from '@aztec/test-wallet/server';
import { TokenContract } from '../src/artifacts';
import { precision } from "../src/utils";
import { AuditableTestWallet } from "@aztec/note-collector";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import { sleep } from "bun";
import { retrieveEncryptedNotes } from "../src/auditor";
import { decryptNote, parseNotePlaintext } from "../src/decrypt";

const { AZTEC_NODE_URL = "http://localhost:8080" } = process.env;

describe("Private Transfer Demo Test", () => {

    let node: AztecNode;
    let wallet: AuditableTestWallet;
    let addresses: AztecAddress[];
    let token: TokenContract;


    before(async () => {
        // setup aztec node client
        node = createAztecNodeClient(AZTEC_NODE_URL);
        console.log(`Connected to Aztec node at "${AZTEC_NODE_URL}"`);

        // setup wallets
        addresses = [];
        wallet = await AuditableTestWallet.create(node, { proverEnabled: false })

        const accounts = await getInitialTestAccountsData();
        for (const account of accounts) {
            const manager = await wallet.createSchnorrAccount(account.secret, account.salt, account.signingKey);
            addresses.push(manager.address);
        }


        // deploy token contracts
        token = await TokenContract.deployWithOpts(
            { wallet, method: "constructor_with_minter" },
            "USD Coin",
            "USDC",
            18,
            addresses[0],
            AztecAddress.ZERO
        ).send({ from: addresses[0] }).deployed();

        // mint tokens
    
        await token.methods.mint_to_private(addresses[1], precision(100n)).send({ from: addresses[0]}).wait();
        await token.methods.mint_to_private(addresses[2], precision(100n)).send({ from: addresses[0]}).wait();
    });

    test("generate tx activity", async () => {
        // send tokens back and forth - 5 transfers in each direction
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(3n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(7n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(5n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(2n), 0).send({ from: addresses[1] }).wait();
        await token.methods.transfer_private_to_private(addresses[1], addresses[2], precision(9n), 0).send({ from: addresses[1] }).wait();

        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(4n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(6n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(8n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(1n), 0).send({ from: addresses[2] }).wait();
        await token.methods.transfer_private_to_private(addresses[2], addresses[1], precision(10n), 0).send({ from: addresses[2] }).wait();
    });

    test("get notes to prove", async () => {
        // Small wait to ensure everything is synced
        await sleep(3000);

        // Step 1: Export tagging secrets from wallet (user side)
        console.log("\n=== STEP 1: Exporting Tagging Secrets ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        console.log("Exported tagging secrets:", taggingSecrets.secrets.length, "secrets");

        // Debug: print the actual secrets
        for (const secret of taggingSecrets.secrets) {
            console.log(`  Secret: ${secret.direction} - counterparty: ${secret.counterparty.toString().slice(0, 16)}... app: ${secret.app.toString().slice(0, 16)}...`);
            console.log(`    Secret value: ${secret.secret.toString()}`);
        }

        // Step 2: Auditor retrieves encrypted notes using the secrets
        console.log("\n=== STEP 2: Retrieving Encrypted Notes ===");
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        // Step 3: Display results organized by secret
        console.log("\n=== RETRIEVAL RESULTS ===");
        console.log(`Account: ${results.account}`);
        console.log(`Total Notes: ${results.totalNotes}`);
        console.log(`Total Transactions: ${results.totalTransactions}`);
        console.log(`Secrets Processed: ${results.secrets.length}`);

        for (const secretResult of results.secrets) {
            console.log(`\n--- Secret: ${secretResult.secret.counterparty.slice(0, 16)}... (${secretResult.secret.direction}) ---`);
            console.log(`  App: ${secretResult.secret.app.slice(0, 16)}...`);
            console.log(`  Notes Found: ${secretResult.noteCount}`);

            // Show first 2 notes for this secret
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

        // Verify we found notes
        expect(results.totalNotes).toBeGreaterThan(0);

        console.log("\n✓ Test complete - encrypted logs retrieved successfully!");
    });

    test("decrypt a note", async () => {
        // Small wait to ensure everything is synced
        await sleep(3000);

        // Step 1: Get encrypted notes from auditor
        console.log("\n=== STEP 1: Retrieving Encrypted Notes ===");
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address], [addresses[2]]);
        const results = await retrieveEncryptedNotes(node, taggingSecrets);

        expect(results.totalNotes).toBeGreaterThan(0);
        console.log(`Found ${results.totalNotes} encrypted notes`);

        // Step 2: Get the first note to decrypt
        const firstNote = results.secrets[0]?.notes[0];
        if (!firstNote) {
            throw new Error("No notes found to decrypt");
        }

        console.log("\n=== STEP 2: Decrypting Note ===");
        console.log(`Note Hash: ${firstNote.noteHash}`);
        console.log(`Tx Hash: ${firstNote.txHash}`);
        console.log(`Ciphertext size: ${firstNote.ciphertextBytes} bytes`);

        // Step 3: Get recipient's keys
        // The recipient is addresses[1] (the account we exported secrets for)
        const pxe = wallet.pxe as any; // Cast to access internal methods
        const registeredAccounts = await pxe.getRegisteredAccounts();
        const recipientCompleteAddress = registeredAccounts.find((acc: any) =>
            acc.address.equals(addresses[1])
        );

        if (!recipientCompleteAddress) {
            throw new Error(`Account ${addresses[1].toString()} not found in PXE`);
        }

        // Get the master incoming viewing secret key
        const ivskM = await pxe.keyStore.getMasterIncomingViewingSecretKey(addresses[1]);

        // Step 4: Decrypt the note
        const encryptedLogBuffer = Buffer.from(firstNote.ciphertext, 'hex');
        const plaintext = await decryptNote(
            encryptedLogBuffer,
            recipientCompleteAddress,
            ivskM
        );

        if (!plaintext) {
            throw new Error("Decryption failed");
        }

        console.log(`✓ Decryption successful! Got ${plaintext.length} fields`);

        // Step 5: Parse the plaintext
        const parsed = parseNotePlaintext(plaintext);
        if (!parsed) {
            throw new Error("Failed to parse plaintext");
        }

        // Extract the note value (for UintNote, the packed note is just the value)
        const value = parsed.packedNote.length > 0 ? parsed.packedNote[0].toBigInt() : 0n;
        const tokenAmount = value / precision(1n);

        console.log("\n=== DECRYPTED NOTE CONTENTS ===");
        console.log(`✓ NOTE VALUE: ${tokenAmount} tokens (${value} raw)`);
        console.log(`Message Type ID: ${parsed.msgTypeId}`);
        console.log(`Note Type ID: ${parsed.noteTypeId}`);
        console.log(`Owner: ${parsed.owner.toString()}`);
        console.log(`Storage Slot: ${parsed.storageSlot.toString()}`);
        console.log(`Randomness: ${parsed.randomness.toString()}`);
        console.log(`Packed Note Fields: ${parsed.packedNote.length}`);

        // Verify the owner matches
        expect(parsed.owner.equals(addresses[1]) || parsed.owner.equals(addresses[2])).toBe(true);

        console.log("\n✓ Test complete - note decrypted successfully!");
    });


});