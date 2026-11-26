//! The object store: posts' bytes and meta files, comments, summaries, on any Apache OpenDAL
//! backend (fs, s3, gcs, azblob, ...), opened as src/storage/opendal.ts opens it, so that the
//! compactor and the API reach the same objects by the same keys.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use opendal::{ErrorKind, Operator};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How much of a local file is read at a time as it is written to the store.
const UPLOAD_CHUNK: usize = 1024 * 1024;

/// What a read of an object that isn't there fails with, where the caller is to know: the
/// same thing whether the store is a local folder or a bucket.
#[derive(Debug, thiserror::Error)]
#[error("NotFound: the store has no \"{0}\"")]
pub struct NotFound(pub String);

/// Whether an error says an object, or a folder of them, isn't there: this crate's own
/// `NotFound`, OpenDAL's, or a local file's.
pub fn is_not_found(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause.is::<NotFound>()
            || cause.downcast_ref::<opendal::Error>().is_some_and(|e| e.kind() == ErrorKind::NotFound)
            || cause.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    })
}

/// An object's size as the store holds it, and its content type where the store keeps one
/// (fs doesn't).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectStat {
    pub size: u64,
    pub content_type: Option<String>,
}

/// One store: an OpenDAL operator, and for a local `fs` store, the directory its files are in.
/// A copy of it shares the operator.
#[derive(Clone)]
pub struct ObjectStore {
    op: Operator,
    /// The directory a local `fs` store keeps its files in; none for a store of any other kind.
    root: Option<PathBuf>,
}

impl ObjectStore {
    /// The store the settings name: an OpenDAL scheme and its options. A local `fs` root is
    /// created on demand; temp-then-rename writes make overwrites atomic for readers.
    pub fn open(scheme: &str, options: &BTreeMap<String, String>) -> Result<Self> {
        opendal::install_default();
        let mut opts = options.clone();
        let fs_root = (scheme == "fs").then(|| opts.get("root").cloned()).flatten();
        if let Some(root) = &fs_root
            && !opts.contains_key("atomic_write_dir")
        {
            opts.insert("atomic_write_dir".into(), format!("{}/.tmp", root.trim_end_matches('/')));
        }
        let op = Operator::via_iter(scheme, opts).with_context(|| format!("could not open the {scheme} store"))?;
        let root = match fs_root {
            Some(root) => Some(std::path::absolute(&root).with_context(|| format!("\"{root}\" is not a folder a store can be in"))?),
            None => None,
        };
        Ok(Self { op, root })
    }

    /// The operator, for what this store has no call of its own for.
    pub fn operator(&self) -> &Operator {
        &self.op
    }

    /// Whether the store can copy an object within itself.
    pub fn copies(&self) -> bool {
        self.op.info().capability().copy
    }

    /// Whether the store signs links to read its objects with, itself.
    pub fn presigns_reads(&self) -> bool {
        self.op.info().capability().presign_read
    }

    /// The file an object of a local `fs` store is, or none for a store of any other kind.
    /// Keys are made of ids: one that led out of the store would be a bug, and not a file.
    pub fn local_file(&self, key: &str) -> Result<Option<PathBuf>> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let path = Path::new(key);
        if path.components().any(|part| !matches!(part, Component::Normal(_))) {
            bail!("\"{key}\" is not an object of the store");
        }
        Ok(Some(root.join(path)))
    }

    /// A whole object, or none if there is none. A local file is read as a file, not through
    /// OpenDAL, whose reader holds megabytes for every read under way, however small the file.
    pub async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let read = match self.local_file(key)? {
            Some(file) => tokio::fs::read(file).await.map_err(anyhow::Error::from),
            None => self.op.read(key).await.map(|buffer| buffer.to_vec()).map_err(anyhow::Error::from),
        };
        match read {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(err).with_context(|| format!("could not read \"{key}\"")),
        }
    }

    /// Writes an object, over the one that was there, with its content type where one is given.
    pub async fn write(&self, key: &str, bytes: Vec<u8>, content_type: Option<&str>) -> Result<()> {
        let write = self.op.write_with(key, bytes);
        match content_type {
            Some(content_type) => write.content_type(content_type).await,
            None => write.await,
        }
        .with_context(|| format!("could not write \"{key}\""))?;
        Ok(())
    }

    /// Writes a local file as an object, over the one that was there, a part at a time.
    pub async fn write_file(&self, key: &str, local: &Path, content_type: &str) -> Result<()> {
        let mut file = tokio::fs::File::open(local)
            .await
            .with_context(|| format!("could not open {}", local.display()))?;
        let mut writer = self
            .op
            .writer_with(key)
            .content_type(content_type)
            .await
            .with_context(|| format!("could not write \"{key}\""))?;
        let copied = async {
            loop {
                let mut chunk = Vec::with_capacity(UPLOAD_CHUNK);
                let read = (&mut file).take(UPLOAD_CHUNK as u64).read_to_end(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                writer.write(chunk).await?;
            }
            anyhow::Ok(())
        }
        .await;
        match copied {
            Ok(()) => {
                writer.close().await.with_context(|| format!("could not write \"{key}\""))?;
                Ok(())
            }
            Err(err) => {
                let _ = writer.abort().await;
                Err(err).with_context(|| format!("could not write \"{key}\""))
            }
        }
    }

    /// Copies an object's bytes to a local file, which is made, or written over. Fails, with
    /// an error `is_not_found` knows, if there is no such object.
    pub async fn fetch_to(&self, key: &str, local: &Path) -> Result<()> {
        if let Some(file) = self.local_file(key)? {
            return match tokio::fs::copy(&file, local).await {
                Ok(_) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound && !file.exists() => Err(NotFound(key.to_owned()).into()),
                Err(err) => Err(err).with_context(|| format!("could not copy \"{key}\" to {}", local.display())),
            };
        }
        let reader = self.op.reader(key).await.map_err(|err| self.missing(key, err))?;
        let mut stream = reader.into_bytes_stream(..).await.map_err(|err| self.missing(key, err))?;
        let mut out = tokio::fs::File::create(local)
            .await
            .with_context(|| format!("could not write {}", local.display()))?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    anyhow::Error::from(NotFound(key.to_owned()))
                } else {
                    anyhow::Error::from(err).context(format!("could not read \"{key}\""))
                }
            })?;
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        Ok(())
    }

    /// An OpenDAL error of a read of `key` as this crate gives it: `NotFound` for an object
    /// that isn't there.
    fn missing(&self, key: &str, err: opendal::Error) -> anyhow::Error {
        if err.kind() == ErrorKind::NotFound {
            NotFound(key.to_owned()).into()
        } else {
            anyhow::Error::from(err).context(format!("could not read \"{key}\""))
        }
    }

    /// Copies an object within the store, over the one at `to`. Fails, with an error
    /// `is_not_found` knows, if there is none at `from`.
    pub async fn copy(&self, from: &str, to: &str) -> Result<()> {
        self.op.copy(from, to).await.map_err(|err| self.missing(from, err))?;
        Ok(())
    }

    /// Copies an object to another through this process, a part at a time, over the one at
    /// `to`: for a store that can't copy within itself. Fails, with an error `is_not_found`
    /// knows, if there is none at `from`.
    pub async fn pipe(&self, from: &str, to: &str, content_type: &str) -> Result<()> {
        if let Some(file) = self.local_file(from)? {
            if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
                return Err(NotFound(from.to_owned()).into());
            }
            return self.write_file(to, &file, content_type).await;
        }
        let reader = self.op.reader(from).await.map_err(|err| self.missing(from, err))?;
        let mut stream = reader.into_bytes_stream(..).await.map_err(|err| self.missing(from, err))?;
        // The first part before there is a writer, so that nothing is written for an object that isn't there.
        let mut next = stream.next().await;
        if let Some(Err(err)) = &next
            && err.kind() == std::io::ErrorKind::NotFound
        {
            return Err(NotFound(from.to_owned()).into());
        }
        let mut writer = self
            .op
            .writer_with(to)
            .content_type(content_type)
            .await
            .with_context(|| format!("could not write \"{to}\""))?;
        let copied = async {
            while let Some(chunk) = next {
                writer.write(chunk?).await?;
                next = stream.next().await;
            }
            anyhow::Ok(())
        }
        .await;
        match copied {
            Ok(()) => {
                writer.close().await.with_context(|| format!("could not write \"{to}\""))?;
                Ok(())
            }
            Err(err) => {
                let _ = writer.abort().await;
                Err(err).with_context(|| format!("could not copy \"{from}\" to \"{to}\""))
            }
        }
    }

    /// Whether the store has the object.
    pub async fn exists(&self, key: &str) -> Result<bool> {
        self.op.exists(key).await.with_context(|| format!("could not look for \"{key}\""))
    }

    /// The object's size and content type, or none if there is no such object.
    pub async fn stat(&self, key: &str) -> Result<Option<ObjectStat>> {
        match self.op.stat(key).await {
            Ok(meta) => Ok(Some(ObjectStat {
                size: meta.content_length(),
                content_type: meta.content_type().filter(|t| !t.is_empty()).map(str::to_owned),
            })),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("could not look at \"{key}\"")),
        }
    }

    /// Deletes an object. One that isn't there is no error.
    pub async fn delete(&self, key: &str) -> Result<()> {
        match self.op.delete(key).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err).with_context(|| format!("could not delete \"{key}\"")),
        }
    }

    /// Deletes every object under a prefix. Nothing there is no error.
    pub async fn remove_all(&self, prefix: &str) -> Result<()> {
        match self.op.delete_with(prefix).recursive(true).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err).with_context(|| format!("could not delete what is under \"{prefix}\"")),
        }
    }

    /// The names of the objects right under a prefix, or with `recursive`, of all the objects
    /// under it, from the prefix on; none, if nothing is.
    pub async fn names(&self, dir: &str, recursive: bool) -> Result<Vec<String>> {
        let entries = match self.op.list_with(dir).recursive(recursive).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(vec![]),
            Err(err) => return Err(err).with_context(|| format!("could not list \"{dir}\"")),
        };
        Ok(entries
            .iter()
            .filter_map(|entry| entry.path().strip_prefix(dir))
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect())
    }
}
