//! Registers the trust plugins: every folder of src/plugins is one, named after the folder, in
//! the order of the folders' names. Adding a plugin is adding a folder whose `mod.rs` has
//! `pub fn plugin() -> Box<dyn TrustPlugin>`: nothing else names it.
//!
//! A folder that holds no `mod.rs` fails the build, whether or not its plugin would run, so
//! that no server is built without an algorithm it was meant to have.

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("the trust plugins are not at {}: {err}", dir.display()))
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();

    let mut code = String::from("// Written by build.rs from the folders of src/plugins.\n");
    for name in &names {
        let file = dir.join(name).join("mod.rs");
        assert!(file.is_file(), "the trust plugin {name} has no mod.rs in {}", dir.join(name).display());
        assert!(
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') && !name.as_bytes()[0].is_ascii_digit(),
            "the trust plugin folder \"{name}\" is not named as a Rust module is: lowercase letters, digits and underscores"
        );
        println!("cargo:rerun-if-changed={}", file.display());
        writeln!(code, "#[path = {:?}]\npub mod {name};", file.display().to_string()).unwrap();
    }
    code.push_str("\n/// What makes a plugin: its folder's `plugin`.\n");
    code.push_str("pub type Maker = fn() -> Box<dyn crate::trust::TrustPlugin>;\n");
    code.push_str("\n/// Every plugin there is, by the name of its folder, in the order of those names.\n");
    code.push_str("pub const REGISTERED: &[(&str, Maker)] = &[\n");
    for name in &names {
        writeln!(code, "    ({name:?}, {name}::plugin),").unwrap();
    }
    code.push_str("];\n");

    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("plugins.rs");
    std::fs::write(out, code).unwrap();
}
