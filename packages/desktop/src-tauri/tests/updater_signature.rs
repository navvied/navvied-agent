//! Proves the exact transport format `docs/DESKTOP.md` asks you to set up (a minisign keypair, the
//! public half base64-wrapped into `tauri.conf.json`'s `plugins.updater.pubkey`, the signature of each
//! release artifact base64-wrapped into `latest.json`) against the same two crates the real pieces use:
//! `minisign` is what `cargo tauri signer` signs with, `minisign-verify` is what `tauri-plugin-updater`
//! verifies with (see its private `verify_signature`, which this mirrors exactly: one base64 decode, then
//! `PublicKey::decode` / `Signature::decode`, then `PublicKey::verify`). No real signing key is used or
//! committed anywhere: the keypair below is generated fresh for this test and discarded.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign::KeyPair;
use minisign_verify::{PublicKey, Signature};

/// What `tauri.conf.json`'s `pubkey` field and `latest.json`'s `signature` field hold: not the raw minisign
/// text (it contains a colon and newlines, not valid base64), but that text's own base64 encoding — the
/// exact extra wrapping `tauri-plugin-updater::updater::verify_signature` undoes with a single decode before
/// handing the result to `minisign-verify`.
fn wrap(raw_minisign_text: &str) -> String {
    STANDARD.encode(raw_minisign_text)
}

fn verify(pubkey_field: &str, signature_field: &str, bytes: &[u8]) -> Result<(), String> {
    let pub_key_decoded = String::from_utf8(STANDARD.decode(pubkey_field).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let public_key = PublicKey::decode(&pub_key_decoded).map_err(|e| e.to_string())?;
    let sig_decoded = String::from_utf8(STANDARD.decode(signature_field).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&sig_decoded).map_err(|e| e.to_string())?;
    public_key.verify(bytes, &signature, true).map_err(|e| e.to_string())
}

#[test]
fn an_update_signed_with_the_matching_key_is_accepted() {
    let kp = KeyPair::generate_unencrypted_keypair().expect("keypair");
    let pubkey_field = wrap(&kp.pk.to_box().expect("pk box").into_string());
    let bytes = b"a fake update artifact, built fresh for this test";
    let sig_box = minisign::sign(Some(&kp.pk), &kp.sk, &bytes[..], None, None).expect("sign");
    let signature_field = wrap(&sig_box.into_string());

    assert!(verify(&pubkey_field, &signature_field, bytes).is_ok());
}

#[test]
fn an_update_signed_with_a_different_key_is_refused() {
    let signer = KeyPair::generate_unencrypted_keypair().expect("signer keypair");
    let configured = KeyPair::generate_unencrypted_keypair().expect("configured keypair");
    let pubkey_field = wrap(&configured.pk.to_box().expect("pk box").into_string());
    let bytes = b"a fake update artifact, built fresh for this test";
    let sig_box = minisign::sign(Some(&signer.pk), &signer.sk, &bytes[..], None, None).expect("sign");
    let signature_field = wrap(&sig_box.into_string());

    let err = verify(&pubkey_field, &signature_field, bytes).expect_err("a signature from the wrong key must be refused");
    assert!(!err.is_empty());
}

#[test]
fn a_tampered_artifact_is_refused_even_with_the_right_key() {
    let kp = KeyPair::generate_unencrypted_keypair().expect("keypair");
    let pubkey_field = wrap(&kp.pk.to_box().expect("pk box").into_string());
    let bytes = b"a fake update artifact, built fresh for this test";
    let sig_box = minisign::sign(Some(&kp.pk), &kp.sk, &bytes[..], None, None).expect("sign");
    let signature_field = wrap(&sig_box.into_string());

    let tampered = b"a fake update artifact, built fresh for this test, plus one extra byte";
    assert!(verify(&pubkey_field, &signature_field, tampered).is_err());
}

#[test]
fn a_hand_edited_signature_field_is_refused_as_malformed_rather_than_silently_accepted() {
    let kp = KeyPair::generate_unencrypted_keypair().expect("keypair");
    let pubkey_field = wrap(&kp.pk.to_box().expect("pk box").into_string());
    let bytes = b"a fake update artifact, built fresh for this test";
    let sig_box = minisign::sign(Some(&kp.pk), &kp.sk, &bytes[..], None, None).expect("sign");
    let mut signature_field = wrap(&sig_box.into_string());
    signature_field.push_str("not-base64-at-all!!");

    assert!(verify(&pubkey_field, &signature_field, bytes).is_err());
}
