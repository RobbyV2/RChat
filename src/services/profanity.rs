use rustrict::CensorStr;

pub fn filter_profanity(text: &str) -> (String, bool) {
    let has_profanity = text.is_inappropriate();

    if has_profanity {
        let filtered = text.censor();
        (filtered, true)
    } else {
        (text.to_string(), false)
    }
}

pub fn contains_profanity(text: &str) -> bool {
    text.is_inappropriate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_profanity() {
        let (filtered, has_profanity) = filter_profanity("This is a fuck test");
        assert!(has_profanity);
        assert!(filtered.contains('*'));
    }

    #[test]
    fn test_no_profanity() {
        let (filtered, has_profanity) = filter_profanity("This is a clean message");
        assert!(!has_profanity);
        assert_eq!(filtered, "This is a clean message");
    }

    #[test]
    fn test_contains_profanity() {
        assert!(contains_profanity("what the fuck"));
        assert!(!contains_profanity("hello world"));
    }
}
