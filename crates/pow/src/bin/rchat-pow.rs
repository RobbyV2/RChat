fn main() {
    let env = |name: &str| std::env::var(name).ok();
    match rchat_pow::cli::run(std::env::args().collect(), &env, &mut std::io::stdin()) {
        Ok(line) => println!("{line}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
