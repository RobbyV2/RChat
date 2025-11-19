use sha2::{Digest, Sha256};

pub fn generate_identicon_data(username: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(username.as_bytes());
    let hash = hasher.finalize();

    format!("{:x}", hash)[..16].to_string()
}

pub fn get_random_color_from_hash(hash: &str) -> String {
    let r = u8::from_str_radix(&hash[0..2], 16).unwrap_or(100);
    let g = u8::from_str_radix(&hash[2..4], 16).unwrap_or(150);
    let b = u8::from_str_radix(&hash[4..6], 16).unwrap_or(200);

    format!("#{:02x}{:02x}{:02x}", r, g, b)
}
