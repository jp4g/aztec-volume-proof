use bb_proof_verification::{UltraHonkZKProof, UltraHonkVerificationKey, verify_honk_proof};

// todo: hardcode 
fn main(
    vkey_left: UltraHonkVerificationKey,
    vkey_right: UltraHonkVerificationKey,
    vkey_hash_left: Field,
    vkey_hash_right: Field,
    proof_left: UltraHonkZKProof,
    proof_right: UltraHonkZKProof,
    leaf_left: Field,
    leaf_right: Field,
    sum_left: Field,
    sum_right: Field
) {
    // 1. recursively prove each of the two leaves (can either be a leaf or intermediate node)
    verify_honk_proof(vkey_left, proof_left, [leaf_left, sum_left], vkey_hash_left);
    verify_honk_proof(vkey_right, proof_right, [leaf_right, sum_right], vkey_hash_right);
    // 3. sum
    let sum = sum_left + sum_right;
    // 3. output sum, vkey hash
}


