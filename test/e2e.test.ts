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
        const taggingSecrets = await wallet.exportTaggingSecrets(addresses[1], [token.address]);
        console.log("tagging secrets", taggingSecrets.secrets[0].secret);
    });

    
});