import { Aes128 } from '@aztec/foundation/crypto/aes128';
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { Point } from '@aztec/foundation/curves/grumpkin';
import { GeneratorIndex } from '@aztec/constants';
import { deriveEcdhSharedSecret } from '@aztec/stdlib/logs';
import { computeAddressSecret } from '@aztec/stdlib/keys';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { CompleteAddress } from '@aztec/stdlib/contract';

/**
 * Decrypt an encrypted note log.
 *
 * Based on the flow from note-encryption-decryption-walkthrough.md
 *
 * @param encryptedLog - The encrypted log buffer (hex string from ciphertext)
 * @param recipientCompleteAddress - The recipient's complete address (includes keys and preaddress)
 * @param ivskM - The recipient's master incoming viewing secret key
 * @returns The decrypted plaintext fields, or null if decryption fails
 */
export async function decryptNote(
    encryptedLog: Buffer,
    recipientCompleteAddress: CompleteAddress,
    ivskM: any, // GrumpkinScalar type
): Promise<Fr[] | null> {
    try {
        // Step 1: Parse ciphertext structure
        // Format: [tag (32 bytes) | eph_pk.x (32 bytes) | rest as fields (31 bytes each)]
        // Skip the tag (first 32 bytes)
        const ciphertextWithoutTag = encryptedLog.slice(32);
        const ephPkX = Fr.fromBuffer(ciphertextWithoutTag.slice(0, 32));

        // The rest are fields packed with 31 bytes per field
        // We need to unpack them back to bytes
        const restFieldsBuffer = ciphertextWithoutTag.slice(32);
        const restBytes = unpackFieldsToBytes(restFieldsBuffer);

        // First byte of the unpacked bytes is the sign of eph_pk
        const ephPkSign = restBytes[0] !== 0;

        // Reconstruct ephemeral public key
        const ephPk = await reconstructPublicKey(ephPkX, ephPkSign);
        if (!ephPk) {
            console.error('Failed to reconstruct ephemeral public key');
            return null;
        }

        // Step 2: Compute address secret
        const preaddress = await recipientCompleteAddress.getPreaddress();
        const addressSecret = await computeAddressSecret(preaddress, ivskM);

        // Step 3: Derive shared secret (ECDH)
        const sharedSecret = await deriveEcdhSharedSecret(addressSecret, ephPk);

        // Step 4: Derive AES symmetric keys from shared secret
        const { bodyKey, bodyIv, headerKey, headerIv } = await deriveAesKeys(sharedSecret);

        // Step 5: Extract and decrypt header
        // Header starts at byte 1 (after sign byte) and is 16 bytes
        const headerCiphertext = restBytes.slice(1, 17);
        const aes = new Aes128();
        const headerPlaintext = await aes.decryptBufferCBC(
            headerCiphertext,
            headerIv,
            headerKey
        );

        // Extract ciphertext length from header (2 bytes, big-endian)
        const ciphertextLength = (headerPlaintext[0] << 8) | headerPlaintext[1];

        // Step 6: Decrypt body
        const availableBytes = restBytes.length - 17;
        const actualLength = Math.min(ciphertextLength, availableBytes);
        const bodyCiphertext = restBytes.slice(17, 17 + actualLength);
        const bodyPlaintext = await aes.decryptBufferCBC(
            bodyCiphertext,
            bodyIv,
            bodyKey
        );

        // Step 7: Convert bytes back to fields (32 bytes per field)
        const fields: Fr[] = [];
        for (let i = 0; i < bodyPlaintext.length; i += 32) {
            if (i + 32 <= bodyPlaintext.length) {
                const fieldBytes = bodyPlaintext.slice(i, i + 32);
                fields.push(Fr.fromBuffer(fieldBytes));
            }
        }

        return fields;
    } catch (error) {
        console.error('Decryption failed:', error);
        return null;
    }
}

/**
 * Derive AES keys and IVs from ECDH shared secret using Poseidon2.
 *
 * This follows the pattern from aes128.nr in the Aztec codebase.
 */
async function deriveAesKeys(sharedSecret: Point): Promise<{
    bodyKey: Buffer;
    bodyIv: Buffer;
    headerKey: Buffer;
    headerIv: Buffer;
}> {
    // Derive two random field elements using Poseidon2 with different separators
    const rand1 = await poseidon2HashWithSeparator(
        [sharedSecret.x, sharedSecret.y],
        GeneratorIndex.SYMMETRIC_KEY
    );
    const rand2 = await poseidon2HashWithSeparator(
        [sharedSecret.x, sharedSecret.y],
        GeneratorIndex.SYMMETRIC_KEY_2
    );

    // Convert to big-endian bytes
    const rand1Bytes = rand1.toBuffer(); // 32 bytes
    const rand2Bytes = rand2.toBuffer(); // 32 bytes

    // Extract 16 bytes from the "little end" of each (last 16 bytes) and reverse
    // Noir code extracts bytes in reverse order: bytes[i] = rand_bytes[31-i]
    const bodyKey = Buffer.from(rand1Bytes.slice(16, 32)).reverse();
    const bodyIv = Buffer.from(rand2Bytes.slice(16, 32)).reverse();

    // Derive header keys the same way but with different separators
    // In the Noir code, they shift the separator by k << 8 for multiple key pairs
    // For the header (second pair), k=1, so add 256 to the separator
    const rand3 = await poseidon2HashWithSeparator(
        [sharedSecret.x, sharedSecret.y],
        (1 << 8) + GeneratorIndex.SYMMETRIC_KEY
    );
    const rand4 = await poseidon2HashWithSeparator(
        [sharedSecret.x, sharedSecret.y],
        (1 << 8) + GeneratorIndex.SYMMETRIC_KEY_2
    );

    const rand3Bytes = rand3.toBuffer();
    const rand4Bytes = rand4.toBuffer();

    const headerKey = Buffer.from(rand3Bytes.slice(16, 32)).reverse();
    const headerIv = Buffer.from(rand4Bytes.slice(16, 32)).reverse();

    return { bodyKey, bodyIv, headerKey, headerIv };
}

/**
 * Unpack fields that were packed with 31 bytes per field back into a continuous byte array.
 * This reverses the bytes_to_fields operation from Noir.
 */
function unpackFieldsToBytes(packedBuffer: Buffer): Buffer {
    const numFields = Math.floor(packedBuffer.length / 32);
    const unpacked: Buffer[] = [];

    for (let i = 0; i < numFields; i++) {
        const fieldBuffer = packedBuffer.slice(i * 32, (i + 1) * 32);
        // Each field stores 31 bytes (the high byte is always 0 in valid field packing)
        // Take the last 31 bytes of the 32-byte field representation
        const bytes31 = fieldBuffer.slice(1, 32);
        unpacked.push(bytes31);
    }

    return Buffer.concat(unpacked);
}

/**
 * Reconstruct a Grumpkin point from its x-coordinate and sign bit.
 */
async function reconstructPublicKey(x: Fr, signBit: boolean): Promise<Point | null> {
    try {
        // Use Point.fromXAndSign to lift x to a point
        // The sign bit tells us which of the two possible y-coordinates to use
        const point = await Point.fromXAndSign(x, signBit);
        return point;
    } catch (error) {
        console.error('Failed to reconstruct point from x-coordinate:', error);
        return null;
    }
}

/**
 * Parse decrypted plaintext into note fields.
 *
 * Plaintext structure for a note:
 * [expanded_metadata, owner, storage_slot, randomness, ...packed_note]
 *
 * @param plaintext - The decrypted field array
 * @returns Parsed note components
 */
export function parseNotePlaintext(plaintext: Fr[]): {
    msgTypeId: bigint;
    noteTypeId: bigint;
    owner: AztecAddress;
    storageSlot: Fr;
    randomness: Fr;
    packedNote: Fr[];
} | null {
    if (plaintext.length < 4) {
        console.error('Plaintext too short to be a valid note');
        return null;
    }

    // Decode expanded metadata (upper 64 bits = msg_type_id, lower 64 bits = note_type_id)
    const expandedMetadata = plaintext[0].toBigInt();
    const msgTypeId = expandedMetadata >> 64n;
    const noteTypeId = expandedMetadata & ((1n << 64n) - 1n);

    // Import AztecAddress here to avoid circular dependency issues
    const { AztecAddress } = require('@aztec/stdlib/aztec-address');

    const owner = AztecAddress.fromField(plaintext[1]);
    const storageSlot = plaintext[2];
    const randomness = plaintext[3];
    const packedNote = plaintext.slice(4);

    return {
        msgTypeId,
        noteTypeId,
        owner,
        storageSlot,
        randomness,
        packedNote,
    };
}
