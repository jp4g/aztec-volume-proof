use dep::aztec::{
    messages::{
        encoding::{decode_message, MESSAGE_CIPHERTEXT_LEN, EPH_PK_X_SIZE_IN_FIELDS},
        encryption::aes128::derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe,
    },
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__SILOED_NOTE_HASH, GENERATOR_INDEX__NOTE_HASH},
        hash::poseidon2_hash_with_separator,
        point::Point,
        traits::{Deserialize, FromField, ToField},
    },
    keys::ecdh_shared_secret::derive_ecdh_shared_secret,
    utils::{
        conversion::{
            bytes_to_fields::bytes_to_fields,
            fields_to_bytes::fields_to_bytes,
        },
        point::{point_from_x_coord_and_sign, get_sign_of_point},
    },
};
pub global HEADER_CIPHERTEXT_SIZE_IN_BYTES: u32 = 16; // not exported
use dep::std::{aes128::aes128_encrypt, embedded_curve_ops::EmbeddedCurveScalar};
use dep::uint_note::uint_note::UintNote;

fn main(
    note_plaintext: BoundedVec<Field, 14>,
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
    note_hash: Field,
    recipient_ivsk_app: Field, // Recipient's app-siloed incoming viewing secret key
    recipient_address: AztecAddress,
) -> pub (Field, Field) {
    // 1. Verify note encrypts to the ciphertext
    verify_encryption(note_plaintext, ciphertext, recipient_ivsk_app, recipient_address);

    // 2. Verify note hashes to the expected hash
    let computed_note_hash = compute_note_hash_from_plaintext(note_plaintext, recipient_address);
    assert(computed_note_hash == note_hash, "Note hash mismatch");

    // 3. Hash the ciphertext with Poseidon
    let ciphertext_hash = poseidon2_hash_with_separator(ciphertext, 0);

    // 4. Create tree leaf H(ciphertext_hash, note_hash)
    let tree_leaf = poseidon2_hash_with_separator([ciphertext_hash, note_hash], 0);

    // 5. Extract note value (for volume constraint)
    // let note_value = get_note_value(note_plaintext);
    let note_value = 0;

    // 6. Output: (note_value, tree_leaf)
    (note_value, tree_leaf)
}

/// Verify that the plaintext encrypts to the given ciphertext
fn verify_encryption(
    plaintext: BoundedVec<Field, 14>,
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN],
    recipient_ivsk_app: Field,
    recipient_address: AztecAddress,
) {
    // Extract ephemeral public key x-coordinate from ciphertext
    let eph_pk_x = ciphertext[0];

    // Extract the encrypted bytes (convert fields back to bytes)
    let ciphertext_without_eph_pk_x = extract_ciphertext_fields(ciphertext);
    let ciphertext_bytes = bytes_from_fields(ciphertext_without_eph_pk_x);

    // First byte contains the ephemeral public key sign
    let eph_pk_sign_byte = ciphertext_bytes[0];
    let eph_pk_sign = eph_pk_sign_byte != 0;

    // Reconstruct ephemeral public key
    // Note: We use a helper since Point::from_x_and_sign might not be directly available
    let eph_pk = reconstruct_public_key(eph_pk_x, eph_pk_sign);

    // Derive shared secret using recipient's secret key and ephemeral public key
    let recipient_sk_scalar = EmbeddedCurveScalar::from_field(recipient_ivsk_app);
    let shared_secret = derive_ecdh_shared_secret(recipient_sk_scalar, eph_pk);

    // Derive AES keys from shared secret
    let pairs = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_poseidon2_unsafe::<2>(shared_secret);
    let (body_sym_key, body_iv) = pairs[0];
    let (header_sym_key, header_iv) = pairs[1];

    // Convert plaintext to bytes
    let mut plaintext_array: [Field; 14] = [0; 14];
    for i in 0..plaintext.len() {
        plaintext_array[i] = plaintext.get(i);
    }
    let plaintext_bytes = fields_to_bytes(plaintext_array);

    // Encrypt the plaintext body
    let computed_body_ciphertext = aes128_encrypt(plaintext_bytes, body_iv, body_sym_key);

    // Compute header ciphertext (contains length)
    let mut header_plaintext = [0 as u8; 2];
    let ciphertext_length = computed_body_ciphertext.len();
    header_plaintext[0] = (ciphertext_length >> 8) as u8;
    header_plaintext[1] = ciphertext_length as u8;
    let computed_header_ciphertext = aes128_encrypt(header_plaintext, header_iv, header_sym_key);

    // Extract actual header and body from provided ciphertext
    let header_start = 1; // After sign byte
    let header_end = header_start + HEADER_CIPHERTEXT_SIZE_IN_BYTES;
    let body_start = header_end;

    // Compare header ciphertext
    for i in 0..HEADER_CIPHERTEXT_SIZE_IN_BYTES {
        assert(
            computed_header_ciphertext[i] == ciphertext_bytes[header_start + i],
            "Header ciphertext mismatch"
        );
    }

    // Compare body ciphertext (up to actual length)
    for i in 0..computed_body_ciphertext.len() {
        if body_start + i < ciphertext_bytes.len() {
            assert(
                computed_body_ciphertext[i] == ciphertext_bytes[body_start + i],
                "Body ciphertext mismatch"
            );
        }
    }

    // Verify ephemeral public key sign byte matches
    assert(eph_pk_sign_byte == get_sign_of_point_as_byte(eph_pk), "Ephemeral PK sign mismatch");
}

/// Compute note hash from plaintext (for UintNote)
/// This follows the exact UintNote hash computation from uint_note.nr
fn compute_note_hash_from_plaintext(
    plaintext: BoundedVec<Field, 14>,
    contract_address: AztecAddress,
) -> Field {
    // Decode plaintext to extract note components
    // todo: needs to be constrained
    let (_, _, msg_content) = unsafe { decode_message(plaintext) };

    // For UintNote plaintext structure:
    // [owner, storage_slot, randomness, value]
    let owner = msg_content.get(0);
    let storage_slot = msg_content.get(1);
    let randomness = msg_content.get(2);
    let value = msg_content.get(3);

    // Step 1: Compute partial commitment (private content)
    // This matches compute_partial_commitment from uint_note.nr
    let partial_commitment = poseidon2_hash_with_separator(
        [owner, storage_slot, randomness],
        GENERATOR_INDEX__NOTE_HASH
    );

    // Step 2: Complete the note hash by adding the value
    // This matches compute_complete_note_hash from uint_note.nr
    let inner_note_hash = poseidon2_hash_with_separator(
        [partial_commitment, value],
        GENERATOR_INDEX__NOTE_HASH
    );

    // Step 3: Compute siloed note hash
    poseidon2_hash_with_separator(
        [contract_address.to_field(), inner_note_hash],
        GENERATOR_INDEX__SILOED_NOTE_HASH
    )
}

/// Extract ciphertext fields (excluding ephemeral PK x-coordinate)
fn extract_ciphertext_fields(
    ciphertext: [Field; MESSAGE_CIPHERTEXT_LEN]
) -> BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN - 1> {
    let mut result = BoundedVec::new();
    for i in EPH_PK_X_SIZE_IN_FIELDS..MESSAGE_CIPHERTEXT_LEN {
        result.push(ciphertext[i]);
    }
    result
}

/// Convert fields to bytes (reverse of bytes_to_fields)
fn bytes_from_fields(fields: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN - 1>) -> [u8; (MESSAGE_CIPHERTEXT_LEN - 1) * 31] {
    let mut bytes = [0 as u8; (MESSAGE_CIPHERTEXT_LEN - 1) * 31];
    for i in 0..fields.len() {
        let field = fields.get(i);
        let field_bytes: [u8; 32] = field.to_be_bytes();
        // Each field stores 31 bytes (skip the high byte)
        for j in 0..31 {
            bytes[i * 31 + j] = field_bytes[j + 1];
        }
    }
    bytes
}

/// Reconstruct a Grumpkin point from x-coordinate and sign
fn reconstruct_public_key(x: Field, sign: bool) -> Point {
    // Use Aztec's utility function
    point_from_x_coord_and_sign(x, sign).expect(f"Invalid ephemeral public key x-coordinate")
}

/// Get the sign of a point as a byte
fn get_sign_of_point_as_byte(point: Point) -> u8 {
    if get_sign_of_point(point) {
        1
    } else {
        0
    }
}

unconstrained fn get_note_value(plaintext: BoundedVec<Field, 14>) -> Field {
    // Decode the message to extract metadata and content
    let (_, _, msg_content) = decode_message(plaintext);

    // Extract the value (for UintNote, it's the 4th field in content)
    msg_content.get(3)
}
