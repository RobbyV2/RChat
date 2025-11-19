use sha2::{Digest, Sha256};

const WORDLIST: &str = include_str!("../data/wordlist.txt");
const SEQUENCE_SIZE: usize = 20;

pub fn get_word_sequence_for_username(username: &str) -> Vec<String> {
    let words: Vec<&str> = WORDLIST.lines().filter(|s| !s.is_empty()).collect();
    let total_words = words.len();

    let mut selected_words = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let base_seed = username.to_lowercase();

    for i in 0..SEQUENCE_SIZE {
        let mut hasher = Sha256::new();
        hasher.update(base_seed.as_bytes());
        hasher.update(i.to_le_bytes());
        let hash = hasher.finalize();

        let index_value = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]);
        let mut word_index = (index_value as usize) % total_words;

        while seen.contains(&word_index) {
            word_index = (word_index + 1) % total_words;
        }

        seen.insert(word_index);
        selected_words.push(words[word_index].to_string());
    }

    selected_words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_word_sequence_deterministic() {
        let username = "testuser";
        let seq1 = get_word_sequence_for_username(username);
        let seq2 = get_word_sequence_for_username(username);
        assert_eq!(seq1, seq2);
        assert_eq!(seq1.len(), SEQUENCE_SIZE);
    }

    #[test]
    fn test_word_sequence_case_insensitive() {
        let seq1 = get_word_sequence_for_username("TestUser");
        let seq2 = get_word_sequence_for_username("testuser");
        assert_eq!(seq1, seq2);
    }

    #[test]
    fn test_word_sequence_different_users() {
        let seq1 = get_word_sequence_for_username("user1");
        let seq2 = get_word_sequence_for_username("user2");
        assert_ne!(seq1, seq2);
    }
}
