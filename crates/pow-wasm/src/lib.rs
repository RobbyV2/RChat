use rchat_pow::puzzle::solve_chunk;

static mut SEED: [u8; 32] = [0; 32];

/// The address of the 32-byte seed buffer. The caller writes the seed there once per challenge.
#[unsafe(no_mangle)]
pub extern "C" fn seed_ptr() -> *mut u8 {
    &raw mut SEED as *mut u8
}

/// Tries `count` nonces of sub-puzzle `sub` from `start`: the winning nonce plus one, or 0.
#[unsafe(no_mangle)]
pub extern "C" fn pow_chunk(sub: u32, start: u64, count: u32, target: u64) -> u64 {
    let seed = unsafe { SEED };
    solve_chunk(&seed, sub as u8, target, start, u64::from(count)).map_or(0, |n| n + 1)
}
