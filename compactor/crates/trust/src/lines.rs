//! Reading text as the API always read it: what it takes for white space, and the lines of
//! a list that is read as it arrives, since a list can be tens of megabytes and is never
//! held whole as text.

use std::error::Error;

pub use evieverse_core::text::{is_space, trim};
use tokio::io::AsyncReadExt;

/// An error with what caused it, in one line: what a failed download is told as.
pub fn cause(err: &(dyn Error + 'static)) -> String {
    let mut said = err.to_string();
    let mut source = err.source();
    while let Some(next) = source {
        let more = next.to_string();
        if !said.contains(&more) {
            said.push_str(": ");
            said.push_str(&more);
        }
        source = next.source();
    }
    said
}

/// Where the bytes of a list come from.
enum Source {
    Response(reqwest::Response),
    File(tokio::fs::File),
}

/// The lines of a file or of a response's body, read as it arrives.
pub struct Lines {
    source: Source,
    /// What was read and isn't a whole line yet.
    rest: Vec<u8>,
    /// Where in `rest` the next line is looked for.
    from: usize,
    ended: bool,
}

impl Lines {
    /// The lines of a response's body.
    pub fn of(response: reqwest::Response) -> Self {
        Self {
            source: Source::Response(response),
            rest: vec![],
            from: 0,
            ended: false,
        }
    }

    /// The lines of a file.
    pub fn of_file(file: tokio::fs::File) -> Self {
        Self {
            source: Source::File(file),
            rest: vec![],
            from: 0,
            ended: false,
        }
    }

    /// The next line, without the line feed that ended it; none once there is no more. The
    /// last line is one whether or not a line feed ends it.
    pub async fn next(&mut self) -> Result<Option<String>, String> {
        loop {
            if let Some(at) = self.rest[self.from..].iter().position(|byte| *byte == b'\n') {
                let line = String::from_utf8_lossy(&self.rest[self.from..self.from + at]).into_owned();
                self.from += at + 1;
                return Ok(Some(line));
            }
            if self.ended {
                let line = String::from_utf8_lossy(&self.rest[self.from..]).into_owned();
                self.from = self.rest.len();
                return Ok((!line.is_empty()).then_some(line));
            }
            // What was given is let go of before more is read.
            self.rest.drain(..self.from);
            self.from = 0;
            match &mut self.source {
                Source::Response(response) => match response.chunk().await.map_err(|err| cause(&err.without_url()))? {
                    Some(chunk) => self.rest.extend_from_slice(&chunk),
                    None => self.ended = true,
                },
                Source::File(file) => {
                    let before = self.rest.len();
                    self.rest.resize(before + 64 * 1024, 0);
                    let read = file.read(&mut self.rest[before..]).await.map_err(|err| err.to_string())?;
                    self.rest.truncate(before + read);
                    self.ended = read == 0;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_the_lines_of_a_file_whether_or_not_the_last_one_is_ended() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.txt");
        let long = "x".repeat(100_000);
        std::fs::write(&path, format!("one\r\n\ntwo é\n{long}\nlast")).unwrap();
        let mut lines = Lines::of_file(tokio::fs::File::open(&path).await.unwrap());
        let mut read = vec![];
        while let Some(line) = lines.next().await.unwrap() {
            read.push(line);
        }
        assert_eq!(read, ["one\r", "", "two é", long.as_str(), "last"]);
        assert_eq!(trim("\u{feff} a b \r\n"), "a b");
    }
}
