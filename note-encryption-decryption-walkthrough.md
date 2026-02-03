# Aztec Note Encryption & Decryption Complete Walkthrough

## Overview of the Architecture

The system has three main phases:
1. **Encryption** (Noir) - When a note is created
2. **Storage & Tagging** (TypeScript) - PXE stores and indexes logs
3. **Decryption** (Noir + PXE Oracles) - When a recipient fetches their notes

---

## Phase 1: Note Encryption (When Creating a Note)

### Step 1.1: Creating and Delivering a Note

When you create a note in Noir, you get a `NoteMessage`:

```rust
// From: aztec/src/note/note_message.nr
let note_message = NoteMessage::new(new_note, context);
note_message.deliver(MessageDelivery.CONSTRAINED_ONCHAIN);
```

### Step 1.2: Encoding the Note to Plaintext

The note gets converted to a message plaintext:

```rust
// Inside deliver() -> private_note_to_message_plaintext()
// Message format:
// [ msg_type_id | msg_metadata | owner | storage_slot | randomness | ...note_fields ]
```

**Message Structure** (from `encoding.nr`):
- **Expanded Metadata** (1 field):
  - Upper 64 bits: `msg_type_id` (e.g., `PRIVATE_NOTE_MSG_TYPE_ID`)
  - Lower 64 bits: `msg_metadata` (note type ID)
- **Content fields**:
  - `owner`: Who owns the note
  - `storage_slot`: Where the note is stored
  - `randomness`: Random value for note commitment
  - `packed_note`: The actual note data

### Step 1.3: AES-128 Encryption

From `aes128.nr`, here's the encryption flow:

```rust
pub fn encrypt(
    plaintext: [Field; PlaintextLen],
    recipient: AztecAddress,
) -> [Field; MESSAGE_CIPHERTEXT_LEN]
```

**Encryption Steps:**

1. **Generate Ephemeral Key Pair**
   ```rust
   let (eph_sk, eph_pk) = generate_ephemeral_key_pair();
   let eph_pk_sign_byte: u8 = get_sign_of_point(eph_pk) as u8;
   ```

2. **Derive Shared Secret (ECDH)**
   ```rust
   let ciphertext_shared_secret = derive_ecdh_shared_secret(
       eph_sk,
       recipient.to_address_point().unwrap().inner,
   );
   ```

3. **Derive Symmetric Keys** (using Poseidon2)
   ```rust
   let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(
       ciphertext_shared_secret,
   );
   let (body_sym_key, body_iv) = pairs[0];      // For encrypting the message
   let (header_sym_key, header_iv) = pairs[1];  // For encrypting the header
   ```

   This derives keys by hashing the shared secret with different domain separators:
   - Hash shared_secret with separator `GENERATOR_INDEX__SYMMETRIC_KEY` → key material 1
   - Hash shared_secret with separator `GENERATOR_INDEX__SYMMETRIC_KEY_2` → key material 2
   - Extract 16 bytes from each to get: `sym_key` (16 bytes) + `iv` (16 bytes)

4. **Convert Plaintext to Bytes**
   ```rust
   let plaintext_bytes = fields_to_bytes(plaintext); // 32 bytes per field
   ```

5. **Encrypt Body**
   ```rust
   let ciphertext_bytes = aes128_encrypt(plaintext_bytes, body_iv, body_sym_key);
   ```

6. **Encrypt Header** (contains ciphertext length)
   ```rust
   let header_plaintext: [u8; 2] = [
       (ciphertext_bytes_length >> 8) as u8,
       ciphertext_bytes_length as u8,
   ];
   let header_ciphertext_bytes = aes128_encrypt(header_plaintext, header_iv, header_sym_key);
   ```

7. **Assemble Final Ciphertext**
   ```
   [ eph_pk.x | eph_pk_sign_byte | header_ciphertext | body_ciphertext | random_padding ]
   ```
   - `eph_pk.x`: 1 field - X-coordinate of ephemeral public key
   - Rest converted to fields (31 bytes packed per field)

### Step 1.4: Tagging and Emission

```rust
// Add tag for recipient to find the log
let log_content = prefix_with_tag(ciphertext, recipient);

// Emit as a private log
context.emit_raw_note_log(log_content, log_content.len(), note_hash_counter);
```

The tag is computed from the recipient's tagging secret and an index.

---

## Phase 2: Storage & Tagging (TypeScript/PXE)

### Step 2.1: PXE Syncs Tagged Logs

From `pxe_oracle_interface.ts:syncTaggedLogs()`:

**What happens:**

1. **Generate Tags** for each recipient and sender pair:
   ```typescript
   const taggingSecret = DirectionalAppTaggingSecret.compute(
       recipientCompleteAddress,
       recipientIvsk,
       sender,
       contractAddress,
       recipient,
   );

   // Generate tags for a window of indices
   for (let i = leftMostIndex; i <= rightMostIndex; i++) {
       const tag = await Tag.compute({ secret: taggingSecret, index: i });
       const siloedTag = SiloedTag.compute(tag, contractAddress);
       tags.push(siloedTag);
   }
   ```

2. **Query Node for Logs**:
   ```typescript
   const logsByTag = await this.node.getLogsByTags(tags);
   ```

3. **Store as PendingTaggedLog**:
   ```typescript
   await this.#storePendingTaggedLogs(
       contractAddress,
       pendingTaggedLogArrayBaseSlot,
       recipient,
       filteredLogsByBlockNumber,
   );
   ```

The logs are stored in a "capsule array" - a storage slot that Noir can read from.

---

## Phase 3: Decryption (Noir + PXE Oracles)

### The Oracle Pattern

**Key Insight**: Noir **cannot** decrypt AES natively. Instead, it uses **oracle calls** to the PXE:

```rust
// From: aztec/src/oracle/aes128_decrypt.nr
#[oracle(utilityAes128Decrypt)]
pub unconstrained fn aes128_decrypt_oracle<let N: u32>(
    ciphertext: BoundedVec<u8, N>,
    iv: [u8; 16],
    sym_key: [u8; 16],
) -> BoundedVec<u8, N> {}

// From: aztec/src/oracle/shared_secret.nr
#[oracle(utilityGetSharedSecret)]
unconstrained fn get_shared_secret_oracle(address: AztecAddress, ephPk: Point) -> Point {}
```

These are **empty functions** in Noir - they're just declarations. The actual implementation is in TypeScript.

### Step 3.1: Process Pending Tagged Logs

When your contract calls the note-fetching oracle, it triggers:

```rust
// From: process_message.nr
pub unconstrained fn process_message_ciphertext<Env>(
    contract_address: AztecAddress,
    compute_note_hash_and_nullifier: ComputeNoteHashAndNullifier<Env>,
    message_ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    message_context: MessageContext,
)
```

### Step 3.2: AES-128 Decryption via Oracles

From `aes128.nr`:

```rust
unconstrained fn decrypt(
    ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    recipient: AztecAddress,
) -> Option<BoundedVec<Field, MESSAGE_PLAINTEXT_LEN>>
```

**Decryption Steps:**

**Step 1: Extract Ephemeral Public Key**
```rust
let eph_pk_x = ciphertext.get(0);
let eph_pk_sign_bool = ciphertext_bytes.get(0) != 0;

let eph_pk = point_from_x_coord_and_sign(eph_pk_x, eph_pk_sign_bool)?;
```

**Step 2: Oracle Call - Get Shared Secret**
```rust
let ciphertext_shared_secret = get_shared_secret(recipient, eph_pk);
```

The oracle computes in PXE (from `pxe_oracle_interface.ts`):
```typescript
async getSharedSecret(address: AztecAddress, ephPk: Point): Promise<Point> {
    const recipientCompleteAddress = await this.getCompleteAddress(address);

    // Get the recipient's secret key
    const ivskM = await this.keyStore.getMasterSecretKey(
        recipientCompleteAddress.publicKeys.masterIncomingViewingPublicKey,
    );

    // Compute address secret: ivsk + hash(...)
    const addressSecret = await computeAddressSecret(
        await recipientCompleteAddress.getPreaddress(),
        ivskM
    );

    // ECDH: addressSecret * ephPk
    return deriveEcdhSharedSecret(addressSecret, ephPk);
}
```

**Step 3: Derive Same Symmetric Keys (Noir Local)**
```rust
let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(
    ciphertext_shared_secret,
);
let (body_sym_key, body_iv) = pairs[0];
let (header_sym_key, header_iv) = pairs[1];
```

**Step 4: Oracle Call - Decrypt Header**
```rust
let header_ciphertext: [u8; 16] = extract_from_ciphertext();
let header_plaintext = aes128_decrypt_oracle(header_ciphertext, header_iv, header_sym_key);

// Extract ciphertext length (2 bytes, big-endian)
let ciphertext_length = ((header_plaintext[0] as u32) << 8) | (header_plaintext[1] as u32);
```

**Step 5: Oracle Call - Decrypt Body**
```rust
let ciphertext = extract_ciphertext_of_length(ciphertext_length);
let plaintext_bytes = aes128_decrypt_oracle(ciphertext, body_iv, body_sym_key);
```

PXE implementation (from `utility_execution_oracle.ts`):
```typescript
public utilityAes128Decrypt(ciphertext: Buffer, iv: Buffer, symKey: Buffer): Promise<Buffer> {
    const aes128 = new Aes128();
    return aes128.decryptBufferCBC(ciphertext, iv, symKey);
}
```

Which calls Barretenberg (from `aes128/index.ts`):
```typescript
public async decryptBufferCBC(data: Uint8Array, iv: Uint8Array, key: Uint8Array) {
    await BarretenbergSync.initSingleton();
    const api = BarretenbergSync.getSingleton();

    // Barretenberg (C++) does the actual AES decryption
    const response = api.aesDecrypt({
        ciphertext: data,
        iv,
        key,
        length: data.length,
    });

    // Remove PKCS#7 padding
    const paddedBuffer = Buffer.from(response.plaintext);
    const paddingToRemove = paddedBuffer[paddedBuffer.length - 1];
    return paddedBuffer.subarray(0, paddedBuffer.length - paddingToRemove);
}
```

**Step 6: Convert Bytes Back to Fields**
```rust
fields_from_bytes(plaintext_bytes)  // Each 32 bytes → 1 field
```

### Step 3.3: Decode the Message

From `encoding.nr`:

```rust
pub unconstrained fn decode_message(
    message: BoundedVec<Field, MESSAGE_PLAINTEXT_LEN>,
) -> (u64, u64, BoundedVec<Field, MAX_MESSAGE_CONTENT_LEN>)
```

This extracts:
- `msg_type_id`: Identifies message type (note, event, partial note)
- `msg_metadata`: Note type ID
- `msg_content`: The actual content fields

### Step 3.4: Process Private Note Message

From `private_notes.nr`:

```rust
pub unconstrained fn process_private_note_msg<Env>(
    contract_address: AztecAddress,
    tx_hash: Field,
    unique_note_hashes_in_tx: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    first_nullifier_in_tx: Field,
    recipient: AztecAddress,
    compute_note_hash_and_nullifier: ComputeNoteHashAndNullifier<Env>,
    msg_metadata: u64,
    msg_content: BoundedVec<Field, MAX_MESSAGE_CONTENT_LEN>,
)
```

**What happens:**

1. **Decode Note Fields**:
   ```rust
   let note_type_id = msg_metadata as Field;
   let owner = msg_content.get(0);
   let storage_slot = msg_content.get(1);
   let randomness = msg_content.get(2);
   let packed_note = msg_content[3..];
   ```

2. **Attempt Nonce Discovery**:
   - Try to find which note hash in the transaction corresponds to this note
   - Computes note hash with different nonces until a match is found

3. **Enqueue for Validation**:
   ```rust
   enqueue_note_for_validation(
       contract_address,
       owner,
       storage_slot,
       randomness,
       note_nonce,
       packed_note,
       note_hash,
       nullifier,
       tx_hash,
       recipient,
   );
   ```

---

## Phase 4: Validation & Storage (Back to TypeScript)

### Step 4.1: Validate Enqueued Notes

From `pxe_oracle_interface.ts:validateEnqueuedNotesAndEvents()`:

Reads validation requests from capsules and calls `deliverNote` for each.

### Step 4.2: Deliver Note to PXE

From `pxe_oracle_interface.ts:deliverNote()`:

**What happens:**

1. **Verify Note Exists**:
   ```typescript
   const uniqueNoteHash = await computeUniqueNoteHash(
       noteNonce,
       await siloNoteHash(contractAddress, noteHash)
   );

   const [noteIndex] = await this.aztecNode.findLeavesIndexes(
       syncedBlockNumber,
       MerkleTreeId.NOTE_HASH_TREE,
       [uniqueNoteHash]
   );
   ```

2. **Check If Nullified**:
   ```typescript
   const [nullifierIndex] = await this.aztecNode.findLeavesIndexes(
       syncedBlockNumber,
       MerkleTreeId.NULLIFIER_TREE,
       [siloedNullifier]
   );
   ```

3. **Store in Database**:
   ```typescript
   const noteDao = new NoteDao(
       new Note(content),
       contractAddress,
       owner,
       storageSlot,
       randomness,
       noteNonce,
       noteHash,
       siloedNullifier,
       txHash,
       blockNumber,
       blockHash,
       index,
   );

   await this.noteDataProvider.addNotes([noteDao], recipient);
   ```

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ 1. NOTE CREATION (Noir Contract)                            │
├─────────────────────────────────────────────────────────────┤
│ • Create note                                               │
│ • Encode: [type|metadata|owner|slot|randomness|...fields]  │
│ • Generate ephemeral keypair (eph_sk, eph_pk)              │
│ • ECDH: shared_secret = eph_sk * recipient_pk              │
│ • Derive keys: Poseidon2(shared_secret)                    │
│ • AES-128 encrypt with derived keys                        │
│ • Prefix with tag for recipient                            │
│ • Emit as private log                                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. LOG SYNC (TypeScript PXE)                               │
├─────────────────────────────────────────────────────────────┤
│ • Generate tags from recipient+sender pairs                 │
│ • Query node: getLogsByTags(tags)                          │
│ • Store in capsule arrays for Noir to access               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. DECRYPTION (Noir Contract + PXE Oracles)                │
├─────────────────────────────────────────────────────────────┤
│ NOIR:                                                       │
│ • Read PendingTaggedLog from capsule                        │
│ • Extract eph_pk from ciphertext                            │
│                                                             │
│ ORACLE CALL: get_shared_secret(recipient, eph_pk)          │
│   ↓                                                         │
│ PXE:                                                        │
│   • Get recipient's secret key from keystore                │
│   • Compute: shared_secret = recipient_sk * eph_pk          │
│   • Return shared_secret to Noir                            │
│   ↑                                                         │
│                                                             │
│ NOIR:                                                       │
│ • Derive keys: Poseidon2(shared_secret) → (key, iv)        │
│                                                             │
│ ORACLE CALL: aes128_decrypt(header_ct, header_iv, header_key)│
│   ↓                                                         │
│ PXE → BARRETENBERG:                                         │
│   • api.aesDecrypt() - Native C++ AES                       │
│   • Return plaintext bytes to Noir                          │
│   ↑                                                         │
│                                                             │
│ NOIR:                                                       │
│ • Extract ciphertext length from header                     │
│                                                             │
│ ORACLE CALL: aes128_decrypt(body_ct, body_iv, body_key)    │
│   ↓                                                         │
│ PXE → BARRETENBERG:                                         │
│   • api.aesDecrypt() - Native C++ AES                       │
│   • Return plaintext bytes to Noir                          │
│   ↑                                                         │
│                                                             │
│ NOIR:                                                       │
│ • Convert bytes to fields                                   │
│ • Decode message: (type, metadata, content)                │
│ • Extract note fields: owner, slot, randomness, note data   │
│ • Nonce discovery: find which note hash matches            │
│ • Enqueue for validation                                    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. VALIDATION & STORAGE (TypeScript PXE)                   │
├─────────────────────────────────────────────────────────────┤
│ • Read validation requests from capsules                    │
│ • Verify note hash exists in note hash tree                │
│ • Check if already nullified                                │
│ • Create NoteDao with all metadata                          │
│ • Store in database (NoteDataProvider)                     │
│ • Available via pxe.getNotes()                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Cryptographic Details

**Shared Secret Derivation:**
```
Encryption:  shared_secret = eph_sk * recipient_address_point
Decryption:  shared_secret = recipient_sk * eph_pk
Result:      Same point (ECDH property)
```

**Key Derivation (Poseidon2):**
```
random_bytes_1 = Poseidon2(shared_secret.x, shared_secret.y, separator_1)
random_bytes_2 = Poseidon2(shared_secret.x, shared_secret.y, separator_2)

sym_key = random_bytes_1[0..16]
iv      = random_bytes_1[16..32]
```

**Ciphertext Format:**
```
Fields:  [ eph_pk.x | encrypted_message_fields... | random_padding ]
Bytes:   [ sign_byte | header_ct(16B) | body_ct(variable) | padding ]
```

---

## Re-encryption in Noir

**Good news**: Noir **CAN** do encryption natively using `std::aes128::aes128_encrypt`!

### Re-encryption Pattern

```rust
use std::aes128::aes128_encrypt;

// After decrypting and processing a note, you can re-encrypt it:

// 1. You already have the plaintext from decryption
let plaintext_bytes: [u8; N] = /* decrypted data */;

// 2. Generate new ephemeral keypair for the new recipient
let (new_eph_sk, new_eph_pk) = generate_ephemeral_key_pair();

// 3. Derive shared secret with new recipient
let new_shared_secret = derive_ecdh_shared_secret(
    new_eph_sk,
    new_recipient.to_address_point().unwrap().inner,
);

// 4. Derive new symmetric keys
let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(
    new_shared_secret,
);
let (new_body_sym_key, new_body_iv) = pairs[0];
let (new_header_sym_key, new_header_iv) = pairs[1];

// 5. Encrypt with the builtin Noir function
let new_ciphertext_bytes = aes128_encrypt(plaintext_bytes, new_body_iv, new_body_sym_key);

// 6. Encrypt the header
let header_plaintext: [u8; 2] = [
    (new_ciphertext_bytes.len() >> 8) as u8,
    new_ciphertext_bytes.len() as u8,
];
let new_header_ciphertext = aes128_encrypt(header_plaintext, new_header_iv, new_header_sym_key);

// 7. Assemble the final ciphertext
// [ new_eph_pk.x | sign_byte | header_ct | body_ct | padding ]
```

### Important: Noir Can Encrypt, Not Decrypt

From the Noir standard library:

```rust
// ✅ AVAILABLE: Encryption
use std::aes128::aes128_encrypt;

// ❌ NOT AVAILABLE: Decryption
// No `aes128_decrypt` in std::aes128
// Must use oracle: aes128_decrypt_oracle()
```

This is **by design** because:
1. **Encryption is deterministic** given inputs → can be constrained in circuits
2. **Decryption requires secret keys** → cannot be exposed in public circuits
3. **Oracles handle secrets safely** → PXE keeps keys secure

---

## Complete Re-encryption Example

```rust
// In your Noir contract
use dep::aztec::messages::encryption::{
    aes128::AES128,
    message_encryption::MessageEncryption,
};

unconstrained fn reencrypt_note_for_new_recipient(
    original_ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    original_recipient: AztecAddress,
    new_recipient: AztecAddress,
) -> [Field; MESSAGE_CIPHERTEXT_LEN] {
    // 1. Decrypt original (uses oracles)
    let plaintext_option = AES128::decrypt(original_ciphertext, original_recipient);

    if plaintext_option.is_none() {
        // Decryption failed
        return [0; MESSAGE_CIPHERTEXT_LEN];
    }

    let plaintext = plaintext_option.unwrap();

    // 2. Convert back to array for re-encryption
    let plaintext_array = plaintext.storage(); // Get underlying array

    // 3. Re-encrypt for new recipient (pure Noir, no oracles!)
    let new_ciphertext = AES128::encrypt(plaintext_array, new_recipient);

    new_ciphertext
}
```

---

## Summary Table

| Operation | Where it Happens | Mechanism |
|-----------|------------------|-----------|
| **Get Shared Secret** | PXE (via oracle) | ECDH: `recipient_sk * eph_pk` |
| **Derive Symmetric Keys** | Noir (local) | Poseidon2 hash of shared secret |
| **AES Decryption** | Barretenberg (via oracle) | Native C++ AES-128-CBC |
| **AES Encryption** | Noir (builtin) | `std::aes128::aes128_encrypt` |
| **Message Encoding** | Noir (local) | Field/byte conversions |
| **Message Decoding** | Noir (local) | Field/byte conversions |

---

## Why This Architecture?

**Security**:
- Secret keys never leave the PXE/keystore
- Noir circuits can't accidentally leak keys
- Oracles act as a secure boundary

**Performance**:
- Barretenberg's C++ AES is fast
- Noir circuits stay small (no AES circuit constraints)
- Unconstrained execution is efficient

**Flexibility**:
- Can decrypt in PXE for storage/indexing
- Can re-encrypt in Noir for note forwarding
- Can verify in circuits without revealing plaintext

**The key takeaway**: Noir is asymmetric - it can encrypt (builtin) but must use oracles to decrypt (PXE with Barretenberg).

---

## Key Files Reference

### Noir Files
- `aztec-nr/aztec/src/messages/encryption/aes128.nr` - AES encryption/decryption interface
- `aztec-nr/aztec/src/oracle/aes128_decrypt.nr` - Decryption oracle declaration
- `aztec-nr/aztec/src/oracle/shared_secret.nr` - Shared secret oracle declaration
- `aztec-nr/aztec/src/messages/discovery/process_message.nr` - Message processing entry point
- `aztec-nr/aztec/src/messages/discovery/private_notes.nr` - Private note message handling
- `aztec-nr/aztec/src/messages/encoding.nr` - Message encoding/decoding

### TypeScript Files
- `yarn-project/pxe/src/contract_function_simulator/oracle/utility_execution_oracle.ts` - Oracle implementations
- `yarn-project/pxe/src/contract_function_simulator/pxe_oracle_interface.ts` - Main PXE oracle interface
- `yarn-project/foundation/src/crypto/aes128/index.ts` - AES wrapper for Barretenberg
- `yarn-project/pxe/src/storage/note_data_provider/note_data_provider.ts` - Note storage

### Working Directory
Current working directory: `/Users/jp4g/Workground/aztec/fde/aztec-packages`
