import { Logger, createLogger } from "@aztec/aztec.js/log";
import { deploySchnorrAccount } from "../src/utils/deploy_account.js";

export async function deployAccount() {
    const logger = createLogger('aztec:aztec-starter');
    const accountName = process.argv[2] || 'aztec devnet tester';
    logger.info(`Creating account: ${accountName}`);
    const { account, credentials } = await deploySchnorrAccount(undefined, accountName);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`Account "${accountName}" created successfully!`);
    logger.info(`Address: ${credentials.address}`);
    logger.info(`${'='.repeat(60)}\n`);
}

deployAccount()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
