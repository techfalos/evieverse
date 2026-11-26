//! Tells the crate which migration of the schema it is built with: the newest file of the
//! API's src/db/migrations, by its name, as the API's migrator names it (src/db/migrator.ts
//! there). A process of this side waits for a database that has had it (see src/db.rs).

use std::path::Path;

fn main() {
    // From compactor/crates/core to the repository, where the API keeps its migrations.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/db/migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("the migrations of the schema are not at {}: {err}", dir.display()))
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".sql").map(str::to_owned))
        // As the migrator takes them: four digits, an underscore, and a name in lowercase.
        .filter(|name| {
            let (number, rest) = name.split_at(name.len().min(4));
            number.len() == 4
                && number.bytes().all(|b| b.is_ascii_digit())
                && rest.len() > 1
                && rest.starts_with('_')
                && rest[1..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
        .collect();
    names.sort();
    let latest = names.last().unwrap_or_else(|| panic!("{} holds no migration", dir.display()));
    println!("cargo:rustc-env=EVIEVERSE_SCHEMA={latest}");
    // Where the migrations are, for the tests that make a database of their own (src/testing.rs).
    let dir = dir.canonicalize().unwrap_or(dir);
    println!("cargo:rustc-env=EVIEVERSE_MIGRATIONS={}", dir.display());
}
