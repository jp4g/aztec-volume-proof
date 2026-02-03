import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { getSponsoredFPCInstance } from "./sponsored_fpc.js";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { Logger, createLogger } from "@aztec/aztec.js/log";
import { setupWallet } from "./setup_wallet.js";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { TestWallet } from "@aztec/test-wallet/server";
import { getTimeouts } from "../../config/config.js";

export interface AccountCredentials {
    secretKey: Fr;
    signingKey: GrumpkinScalar;
    salt: Fr;
    address: AztecAddress;
}

export async function deploySchnorrAccount(
    wallet?: TestWallet,
    accountName?: string
): Promise<{ account: AccountManager; credentials: AccountCredentials }> {
    const logger = createLogger('aztec:account');
    const name = accountName || 'Schnorr Account';
    logger.info(`Creating new account: ${name}...`);

    // Generate keys
    const secretKey = Fr.random();
    const signingKey = GrumpkinScalar.random();
    const salt = Fr.random();

    // IMPORTANT: Log credentials for saving
    logger.info('='.repeat(60));
    logger.info(`Account Name: ${name}`);
    logger.info('Save these credentials:');
    logger.info(`SECRET=${secretKey.toString()}`);
    logger.info(`SIGNING_KEY=${signingKey.toString()}`);
    logger.info(`SALT=${salt.toString()}`);
    logger.info('='.repeat(60));

    // Create account
    const activeWallet = wallet ?? await setupWallet();
    const account = await activeWallet.createSchnorrAccount(secretKey, salt, signingKey);
    logger.info(`Account address: ${account.address}`);

    // Setup fee payment
    const sponsoredFPC = await getSponsoredFPCInstance();
    await activeWallet.registerContract(sponsoredFPC, SponsoredFPCContract.artifact);
    const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

    // Deploy account with appropriate timeout
    const timeouts = getTimeouts();
    logger.info(`Deploying account (timeout: ${timeouts.deployTimeout / 1000}s)...`);

    const deployMethod = await account.getDeployMethod();
    const tx = await deployMethod.send({
        from: AztecAddress.ZERO,
        fee: { paymentMethod }
    }).wait({ timeout: timeouts.deployTimeout });

    logger.info(`Account deployed! Tx: ${tx.txHash}`);

    return {
        account,
        credentials: {
            secretKey,
            signingKey,
            salt,
            address: account.address
        }
    };
}
