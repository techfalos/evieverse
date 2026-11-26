//! Azure Blob Storage as the managed identity of the place the process runs in, with no
//! account key: what src/storage/azureIdentity.ts is to the API, for the stores this process
//! opens.
//!
//! OpenDAL asks for the identity's token the way a virtual machine's metadata service is asked
//! (`api-version=2018-02-01`). A Container App, like App Service and Functions, gives tokens at
//! IDENTITY_ENDPOINT, to a request that carries IDENTITY_HEADER, and from `2019-08-01` on. So
//! the process runs a relay on its own loopback address that takes the one request and makes
//! the other, and tells OpenDAL to ask there (AZURE_IMDS_ENDPOINT).
//!
//! It applies where the process has such an identity (IDENTITY_ENDPOINT and IDENTITY_HEADER
//! are set) and a store's options have neither an `account_key` nor a `sas_token`. This
//! process signs no links, so the other half of the API's file, the user delegation key, has
//! no part here.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// The version of the identity endpoint's API asked for: the first that Container Apps, App
/// Service and Functions answer.
const IDENTITY_API_VERSION: &str = "2019-08-01";
/// The resource a token for Blob Storage is asked for.
const STORAGE_RESOURCE: &str = "https://storage.azure.com/";
/// A token with less than this left is not given out, and a new one is asked for: what OpenDAL
/// is given must outlast the calls it makes with it.
const TOKEN_MARGIN_SECONDS: i64 = 5 * 60;
/// How long one call to the identity endpoint may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(3);
/// How many times a call is made before it has failed: one that got no answer, or a 5xx, is
/// made once more.
const ATTEMPTS: usize = 2;
/// The pause before a call is made again.
const PAUSE: Duration = Duration::from_millis(100);
/// The most a request to the relay may measure, up to the end of its headers.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// The managed identity the environment tells of.
#[derive(Debug, Clone)]
pub struct ManagedIdentity {
    /// Where its tokens are asked for (IDENTITY_ENDPOINT).
    pub endpoint: String,
    /// What a request for one carries (IDENTITY_HEADER).
    pub header: String,
    /// Which identity, where the place has several (AZURE_CLIENT_ID).
    pub client_id: Option<String>,
}

/// The value of an environment variable that is set to something.
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The managed identity the environment tells of, or none where it tells of none.
pub fn managed_identity() -> Option<ManagedIdentity> {
    Some(ManagedIdentity {
        endpoint: env("IDENTITY_ENDPOINT")?,
        header: env("IDENTITY_HEADER")?,
        client_id: env("AZURE_CLIENT_ID"),
    })
}

/// Whether an `azblob` store with these options is the managed identity's to reach: it has no
/// key of its own, and there is an identity.
pub fn uses_managed_identity(options: &BTreeMap<String, String>) -> bool {
    let set = |name: &str| options.get(name).is_some_and(|value| !value.is_empty());
    !set("account_key") && !set("sas_token") && managed_identity().is_some()
}

/// A token of the identity, and when it expires, in seconds of the Unix epoch.
#[derive(Debug, Clone)]
struct IdentityToken {
    access_token: String,
    expires_on: i64,
}

/// The relay of this process: bound, and not yet answering (see `TokenRelay::serve`).
pub struct TokenRelay {
    listener: std::net::TcpListener,
    secret: String,
    identity: ManagedIdentity,
}

impl TokenRelay {
    /// Binds the relay of this process and tells OpenDAL of it, where the process has a
    /// managed identity and the deployment doesn't say itself where OpenDAL is to ask
    /// (AZURE_IMDS_ENDPOINT is set): none otherwise.
    ///
    /// It listens on 127.0.0.1 alone, on a port the system picks, and answers only a request
    /// that carries a secret made here, which OpenDAL is given beside the address
    /// (AZURE_MSI_SECRET), so nothing else on the machine gets a token of it. A request made
    /// before `serve` runs waits for it.
    ///
    /// # Safety
    ///
    /// It sets two variables of the process's environment, which nothing else may read or
    /// write meanwhile: call it before the process has a second thread.
    #[allow(unsafe_code)]
    pub unsafe fn bind() -> Result<Option<Self>> {
        let Some(identity) = managed_identity() else {
            return Ok(None);
        };
        if env("AZURE_IMDS_ENDPOINT").is_some() {
            return Ok(None);
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).context("the token relay could not listen on the loopback address")?;
        listener.set_nonblocking(true)?;
        let secret = hex::encode(rand::random::<[u8; 32]>());
        // SAFETY: the caller sees to it that no other thread reads or writes the environment (see above).
        unsafe {
            std::env::set_var("AZURE_IMDS_ENDPOINT", format!("http://127.0.0.1:{}/token", listener.local_addr()?.port()));
            std::env::set_var("AZURE_MSI_SECRET", &secret);
        }
        Ok(Some(Self { listener, secret, identity }))
    }

    /// Answers the requests made to the relay, for as long as the process runs.
    pub async fn serve(self) -> Result<()> {
        let listener = TcpListener::from_std(self.listener)?;
        let relay = Arc::new(Relay {
            secret: self.secret,
            identity: self.identity,
            http: reqwest::Client::builder().timeout(CALL_TIMEOUT).build()?,
            tokens: Mutex::new(HashMap::new()),
        });
        loop {
            let (stream, _) = listener.accept().await?;
            let relay = relay.clone();
            tokio::spawn(async move {
                // A request that can't be read or answered is its sender's to make again.
                let _ = relay.answer(stream).await;
            });
        }
    }
}

/// What the relay answers with.
struct Relay {
    secret: String,
    identity: ManagedIdentity,
    http: reqwest::Client,
    /// The tokens asked for so far, by the identity and the resource they are of.
    tokens: Mutex<HashMap<(String, String), IdentityToken>>,
}

/// Whether two strings are the same, in a time that tells nothing of where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The method, the target and the `x-identity-header` of an HTTP request, read from its head.
fn request_of(head: &str) -> Option<(&str, &str, &str)> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?, first.next()?);
    let given = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("x-identity-header"))
        .map_or("", |(_, value)| value.trim());
    Some((method, target, given))
}

impl Relay {
    /// A token of the process's managed identity for `resource`, kept until shortly before it
    /// expires. `client_id` says which identity, where it isn't the one AZURE_CLIENT_ID names.
    async fn token(&self, resource: &str, client_id: Option<&str>) -> Result<IdentityToken> {
        let client = client_id.filter(|id| !id.is_empty()).or(self.identity.client_id.as_deref());
        let kept = (client.unwrap_or_default().to_owned(), resource.to_owned());
        let mut tokens = self.tokens.lock().await;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64;
        if let Some(token) = tokens.get(&kept)
            && token.expires_on - now > TOKEN_MARGIN_SECONDS
        {
            return Ok(token.clone());
        }
        let mut url = url::Url::parse(&self.identity.endpoint).context("IDENTITY_ENDPOINT is not a URL")?;
        url.query_pairs_mut()
            .append_pair("api-version", IDENTITY_API_VERSION)
            .append_pair("resource", resource);
        if let Some(client) = client {
            url.query_pairs_mut().append_pair("client_id", client);
        }
        let mut attempt = 1;
        let body: Value = loop {
            let sent = self.http.get(url.clone()).header("x-identity-header", &self.identity.header).send().await;
            match sent {
                Ok(res) if res.status().is_success() => break res.json().await.context("the managed identity endpoint gave no token")?,
                Ok(res) if res.status().is_server_error() && attempt < ATTEMPTS => {}
                Ok(res) => {
                    let status = res.status().as_u16();
                    let said: String = res.text().await.unwrap_or_default().chars().take(300).collect();
                    bail!("the managed identity endpoint answered {status}: {said}");
                }
                Err(_) if attempt < ATTEMPTS => {}
                Err(err) => return Err(anyhow!("the managed identity endpoint gave no answer: {err}")),
            }
            attempt += 1;
            tokio::time::sleep(PAUSE).await;
        };
        // The time it expires at is a number of seconds, which some of these services write as a string.
        let expires_on = match &body["expires_on"] {
            Value::String(text) => text.trim().parse::<f64>().ok(),
            Value::Number(number) => number.as_f64(),
            _ => None,
        };
        let (Some(access_token), Some(expires_on)) = (body["access_token"].as_str(), expires_on.filter(|at| at.is_finite() && *at > 0.0)) else {
            bail!("the managed identity endpoint gave no token");
        };
        let fresh = IdentityToken {
            access_token: access_token.to_owned(),
            expires_on: expires_on as i64,
        };
        tokens.insert(kept, fresh.clone());
        Ok(fresh)
    }

    /// Answers one request to the relay: a token for the resource it names, in the form a
    /// virtual machine's metadata service gives one.
    async fn answer(&self, mut stream: TcpStream) -> Result<()> {
        let mut head = Vec::new();
        let mut chunk = [0u8; 1024];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).await?;
            if read == 0 || head.len() + read > MAX_REQUEST_BYTES {
                bail!("not a request");
            }
            head.extend_from_slice(&chunk[..read]);
        }
        let head = String::from_utf8_lossy(&head);
        let (status, body) = match request_of(&head) {
            Some(("GET", target, given)) if same(given.as_bytes(), self.secret.as_bytes()) => {
                let query = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
                let param = |name: &str| {
                    query
                        .as_ref()
                        .and_then(|url| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()))
                };
                let resource = param("resource")
                    .filter(|resource| !resource.is_empty())
                    .unwrap_or_else(|| STORAGE_RESOURCE.to_owned());
                match self.token(&resource, param("client_id").as_deref()).await {
                    // expires_on as the seconds of the Unix epoch, in a string: the one form OpenDAL reads.
                    Ok(token) => (
                        "200 OK",
                        json!({ "access_token": token.access_token, "expires_on": token.expires_on.to_string(), "resource": resource, "token_type": "Bearer" }),
                    ),
                    Err(err) => ("502 Bad Gateway", json!({ "error": err.to_string() })),
                }
            }
            _ => ("403 Forbidden", Value::Null),
        };
        let body = if body.is_null() { String::new() } else { body.to_string() };
        let answer = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(answer.as_bytes()).await?;
        stream.shutdown().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_a_request_asks_and_carries() {
        let head = "GET /token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F HTTP/1.1\r\nHost: 127.0.0.1\r\nX-IDENTITY-HEADER: abc\r\nMetadata: true\r\n\r\n";
        assert_eq!(
            request_of(head),
            Some(("GET", "/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F", "abc"))
        );
        assert_eq!(request_of("POST /token HTTP/1.1\r\n\r\n"), Some(("POST", "/token", "")));
        assert!(same(b"abc", b"abc") && !same(b"abc", b"abd") && !same(b"abc", b"ab"));
    }
}
