//! Explicit, host-side journal lookup. Nothing here writes config or provenance.
use crate::{env::Env, secrets};
use reqwest::{blocking::Client, redirect::Policy, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const EASY_SCHOLAR: &str = "https://www.easyscholar.cc/open/getPublicationRank";
const EASY_SCHOLAR_HOST: &str = "www.easyscholar.cc";
const CROSSREF: &str = "https://api.crossref.org/works/";
const MAX_BODY: u64 = 512 * 1024;
const SECRET_ID: &str = "journal.easyScholar";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JournalErrorCode {
    NotConfigured,
    InvalidKey,
    RateLimited,
    Unavailable,
    NotFound,
    InvalidQuery,
    InvalidResponse,
    CredentialStoreUnavailable,
    DesktopOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct JournalError {
    pub code: JournalErrorCode,
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.code {
            JournalErrorCode::NotConfigured => "easyScholar is not configured.",
            JournalErrorCode::InvalidKey => "The easyScholar key was rejected.",
            JournalErrorCode::RateLimited => "easyScholar has limited requests. Try again later.",
            JournalErrorCode::Unavailable => "The journal service is unavailable.",
            JournalErrorCode::NotFound => "No journal information was found.",
            JournalErrorCode::InvalidQuery => "Enter a journal name or DOI.",
            JournalErrorCode::InvalidResponse => "The journal service returned invalid data.",
            JournalErrorCode::CredentialStoreUnavailable => {
                "The operating system credential store is unavailable."
            }
            JournalErrorCode::DesktopOnly => "Manage the easyScholar key in the desktop app.",
        })
    }
}
impl std::error::Error for JournalError {}
impl From<secrets::SecretError> for JournalError {
    fn from(_: secrets::SecretError) -> Self {
        error(JournalErrorCode::CredentialStoreUnavailable)
    }
}
fn error(code: JournalErrorCode) -> JournalError {
    JournalError { code }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct JournalStatus {
    pub configured: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Metric<T> {
    pub value: T,
    pub year: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalInfo {
    pub publication_name: String,
    pub doi: Option<String>,
    pub issns: Vec<String>,
    pub impact_factor: Option<Metric<f64>>,
    pub impact_factor5_year: Option<Metric<f64>>,
    pub jcr_quartile: Option<Metric<String>>,
    pub cas_partition: Option<Metric<String>>,
    pub source: JournalSource,
    pub fetched_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum JournalSource {
    #[serde(rename = "easyScholar")]
    EasyScholar,
}

type Cache = HashMap<(String, String), (Instant, Result<JournalInfo, JournalError>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn status(env: &Env) -> Result<JournalStatus, JournalError> {
    Ok(JournalStatus {
        configured: secrets::read(env, SECRET_ID)?.is_some_and(|s| !s.is_empty()),
    })
}

pub fn save_key(env: &Env, key: &str) -> Result<JournalStatus, JournalError> {
    // Treat the key as opaque. URL query encoding handles its punctuation;
    // reject only empty, oversized or whitespace-containing credentials.
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(error(JournalErrorCode::InvalidKey));
    }
    let mut cached = cache()
        .lock()
        .map_err(|_| error(JournalErrorCode::Unavailable))?;
    secrets::write(env, SECRET_ID, key)?;
    cached.retain(|(scope, _), _| scope != &secrets::scope(env));
    Ok(JournalStatus { configured: true })
}

pub fn delete_key(env: &Env) -> Result<JournalStatus, JournalError> {
    let mut cached = cache()
        .lock()
        .map_err(|_| error(JournalErrorCode::Unavailable))?;
    secrets::delete(env, SECRET_ID)?;
    cached.retain(|(scope, _), _| scope != &secrets::scope(env));
    Ok(JournalStatus { configured: false })
}

enum Query {
    Doi(String),
    Publication(String),
}
fn query(value: &str) -> Result<Query, JournalError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(error(JournalErrorCode::InvalidQuery));
    }
    let lower = value.to_ascii_lowercase();
    let doi = [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "doi:",
    ]
    .iter()
    .find_map(|prefix| {
        lower
            .strip_prefix(prefix)
            .map(|_| value[prefix.len()..].trim())
    });
    if let Some(doi) = doi.or_else(|| lower.starts_with("10.").then_some(value)) {
        let valid = doi.split_once('/').is_some_and(|(prefix, suffix)| {
            let digits = prefix.strip_prefix("10.").unwrap_or("");
            (4..=9).contains(&digits.len())
                && digits.bytes().all(|b| b.is_ascii_digit())
                && !suffix.is_empty()
                && !doi.chars().any(char::is_whitespace)
                && !doi.contains(['?', '#'])
        });
        return if valid {
            Ok(Query::Doi(doi.to_ascii_lowercase()))
        } else {
            Err(error(JournalErrorCode::InvalidQuery))
        };
    }
    if lower.contains("://") || lower.contains("secretkey=") {
        return Err(error(JournalErrorCode::InvalidQuery));
    }
    Ok(Query::Publication(value.to_string()))
}

pub fn lookup(env: &Env, input: &str) -> Result<JournalInfo, JournalError> {
    let parsed = query(input)?;
    // The lock coalesces concurrent equal requests, also covering a key change
    // while a request is in flight. There are at most 64 in-memory results.
    let mut cached = cache()
        .lock()
        .map_err(|_| error(JournalErrorCode::Unavailable))?;
    let secret = secrets::read(env, SECRET_ID)?
        .filter(|s| !s.is_empty())
        .ok_or(error(JournalErrorCode::NotConfigured))?;
    let normalized = match &parsed {
        Query::Doi(s) => format!("doi:{s}"),
        Query::Publication(s) => format!("name:{}", s.to_lowercase()),
    };
    let cache_key = (secrets::scope(env), normalized);
    cached.retain(|_, (at, result)| {
        at.elapsed() < Duration::from_secs(if result.is_ok() { 3600 } else { 5 })
    });
    if let Some((_, result)) = cached.get(&cache_key) {
        return result.clone();
    }
    let result = fetch(parsed, &secret);
    if cached.len() >= 64 {
        if let Some(key) = cached.keys().next().cloned() {
            cached.remove(&key);
        }
    }
    cached.insert(cache_key, (Instant::now(), result.clone()));
    result
}

fn client() -> Result<Client, JournalError> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .user_agent("SciMesh/journal")
        .build()
        .map_err(|_| error(JournalErrorCode::Unavailable))
}

fn check_source(url: &Url, host: &str) -> Result<(), JournalError> {
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    Ok(())
}

fn http_error(status: StatusCode) -> JournalError {
    error(match status.as_u16() {
        401 | 403 => JournalErrorCode::InvalidKey,
        404 => JournalErrorCode::NotFound,
        429 => JournalErrorCode::RateLimited,
        _ => JournalErrorCode::Unavailable,
    })
}

fn read_json(reader: impl Read) -> Result<Value, JournalError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(JournalErrorCode::Unavailable))?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    serde_json::from_slice(&bytes).map_err(|_| error(JournalErrorCode::InvalidResponse))
}

fn request(client: &Client, url: Url, host: &str) -> Result<Value, JournalError> {
    check_source(&url, host)?;
    // reqwest errors contain the credential-bearing URL. Never format, log, or
    // serialize them. Reject redirects instead of forwarding the key.
    let response = client
        .get(url)
        .send()
        .map_err(|_| error(JournalErrorCode::Unavailable))?;
    check_source(response.url(), host)?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    if response.content_length().is_some_and(|n| n > MAX_BODY) {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    read_json(response)
}

fn fetch(query: Query, secret: &str) -> Result<JournalInfo, JournalError> {
    let client = client()?;
    let (name, doi, issns) = match query {
        Query::Publication(name) => (name, None, Vec::new()),
        Query::Doi(doi) => {
            let mut url = Url::parse(CROSSREF).map_err(|_| error(JournalErrorCode::Unavailable))?;
            url.path_segments_mut()
                .map_err(|_| error(JournalErrorCode::Unavailable))?
                .pop_if_empty()
                .push(&doi);
            let (name, issns) = parse_crossref(&request(&client, url, "api.crossref.org")?)?;
            (name, Some(doi), issns)
        }
    };
    let mut url = Url::parse(EASY_SCHOLAR).map_err(|_| error(JournalErrorCode::Unavailable))?;
    url.query_pairs_mut()
        .append_pair("publicationName", &name)
        .append_pair("secretKey", secret);
    let body = request(&client, url, EASY_SCHOLAR_HOST)?;
    let mut info = parse_rank(&body, &name)?;
    info.doi = doi;
    info.issns = issns;
    info.fetched_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(info)
}

fn parse_crossref(body: &Value) -> Result<(String, Vec<String>), JournalError> {
    if body.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    let message = &body["message"];
    let name = message["container-title"]
        .as_array()
        .and_then(|titles| {
            titles
                .iter()
                .filter_map(Value::as_str)
                .find(|s| !s.trim().is_empty())
        })
        .ok_or(error(JournalErrorCode::NotFound))?
        .trim();
    if name.len() > 512 || name.chars().any(char::is_control) {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    let mut issns = Vec::new();
    if let Some(items) = message["ISSN"].as_array() {
        for item in items.iter().take(16).filter_map(Value::as_str) {
            let valid = item.len() == 9
                && item.as_bytes()[4] == b'-'
                && item
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| i == 4 || b.is_ascii_digit() || (i == 8 && b == b'X'));
            if valid && !issns.iter().any(|s| s == item) {
                issns.push(item.to_string());
            }
        }
    }
    Ok((name.to_string(), issns))
}

fn year(value: Option<&Value>) -> Option<u16> {
    let year = value.and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse().ok()))?;
    (1900..=2200).contains(&year).then_some(year as u16)
}

fn field<'a>(rank: &'a Value, name: &str) -> Option<&'a Value> {
    rank.get("all")
        .and_then(|v| v.get(name))
        .filter(|v| !v.is_null())
        .or_else(|| {
            rank.get("select")
                .and_then(|v| v.get(name))
                .filter(|v| !v.is_null())
        })
}
fn metric_year(rank: &Value, name: &str, value: &Value) -> Option<u16> {
    year(value.get("year")).or_else(|| year(field(rank, &format!("{name}Year"))))
}
fn metric_value(value: &Value) -> &Value {
    value.get("value").unwrap_or(value)
}
fn numeric(rank: &Value, name: &str) -> Option<Metric<f64>> {
    let raw = field(rank, name)?;
    let value = metric_value(raw);
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    (number.is_finite() && number >= 0.0).then(|| Metric {
        value: number,
        year: metric_year(rank, name, raw),
    })
}
fn partition(rank: &Value, name: &str, jcr: bool) -> Option<Metric<String>> {
    let raw = field(rank, name)?;
    let text = metric_value(raw).as_str()?.trim();
    // Return only recognized categories; arbitrary upstream strings can echo a
    // secret or contain HTML. Numeric metrics also never echo upstream text.
    let value = if jcr {
        match text.to_ascii_uppercase().as_str() {
            "Q1" | "1" | "1区" => "Q1",
            "Q2" | "2" | "2区" => "Q2",
            "Q3" | "3" | "3区" => "Q3",
            "Q4" | "4" | "4区" => "Q4",
            _ => return None,
        }
    } else {
        match text {
            "1" | "1区" | "Zone 1" => "Zone 1",
            "2" | "2区" | "Zone 2" => "Zone 2",
            "3" | "3区" | "Zone 3" => "Zone 3",
            "4" | "4区" | "Zone 4" => "Zone 4",
            _ => return None,
        }
    };
    Some(Metric {
        value: value.to_string(),
        year: metric_year(rank, name, raw),
    })
}

fn parse_rank(body: &Value, name: &str) -> Result<JournalInfo, JournalError> {
    let code = body
        .get("code")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .ok_or(error(JournalErrorCode::InvalidResponse))?;
    if code != 200 {
        return Err(error(match code {
            401 | 403 | 40002 => JournalErrorCode::InvalidKey,
            429 => JournalErrorCode::RateLimited,
            404 => JournalErrorCode::NotFound,
            _ => JournalErrorCode::Unavailable,
        }));
    }
    let rank = body
        .get("data")
        .and_then(|v| v.get("officialRank"))
        .ok_or(error(JournalErrorCode::NotFound))?;
    if !rank.is_object() {
        return Err(error(JournalErrorCode::InvalidResponse));
    }
    let info = JournalInfo {
        publication_name: name.to_string(),
        doi: None,
        issns: Vec::new(),
        impact_factor: numeric(rank, "sciif"),
        impact_factor5_year: numeric(rank, "sciif5"),
        jcr_quartile: partition(rank, "sci", true).or_else(|| partition(rank, "ssci", true)),
        cas_partition: partition(rank, "sciUp", false)
            .or_else(|| partition(rank, "sciBase", false)),
        source: JournalSource::EasyScholar,
        fetched_at: 0,
    };
    if info.impact_factor.is_none()
        && info.impact_factor5_year.is_none()
        && info.jcr_quartile.is_none()
        && info.cas_partition.is_none()
    {
        return Err(error(JournalErrorCode::NotFound));
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    #[ignore = "requires network access and an unlocked host OS credential store"]
    fn live_endpoint_rejects_a_synthetic_key_with_a_typed_error() {
        let root = std::env::temp_dir().join(format!(
            "osd-journal-check-{}",
            crate::runtime::random_hex(8)
        ));
        let env = Env::new(root.clone(), root.clone(), None, "test".into());
        struct Cleanup(Env);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_key(&self.0);
            }
        }
        let _cleanup = Cleanup(env.clone());
        save_key(&env, "invalid-synthetic-key").unwrap();
        let result = lookup(&env, "Nature").unwrap_err();
        assert_eq!(result.code, JournalErrorCode::InvalidKey);
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"code":"invalid_key"}"#
        );
        assert!(!root.exists());
    }
    #[test]
    fn zero_is_data_and_fetch_year_is_not_a_metric_year() {
        let info = parse_rank(&json!({"code":200,"data":{"officialRank":{"all":{"sciif":"0", "sciif5":"2.30", "sci":"Q1", "sciUp":"2区"}}}}), "Example").unwrap();
        assert_eq!(
            info.impact_factor,
            Some(Metric {
                value: 0.0,
                year: None
            })
        );
        assert_eq!(
            info.impact_factor5_year,
            Some(Metric {
                value: 2.3,
                year: None
            })
        );
        assert_eq!(info.cas_partition.unwrap().value, "Zone 2");
        assert_eq!(info.jcr_quartile.unwrap().value, "Q1");
        let json = serde_json::to_value(&info.impact_factor5_year).unwrap();
        assert_eq!(json["year"], Value::Null);
    }
    #[test]
    fn selects_explicit_years_and_rejects_nonfinite_or_negative_metrics() {
        let info = parse_rank(&json!({"code":200,"data":{"officialRank":{"all":{"sciif":"NaN", "sciif5":"-1"},"select":{"sci":{"value":"Q2","year":2023}}}}}), "Example").unwrap();
        assert!(info.impact_factor.is_none());
        assert!(info.impact_factor5_year.is_none());
        assert_eq!(info.jcr_quartile.unwrap().year, Some(2023));
        assert!(numeric(&json!({"all":{"sciif":"inf"}}), "sciif").is_none());
    }
    #[test]
    fn error_payloads_never_echo_upstream_messages() {
        for (code, expected) in [
            (40002, JournalErrorCode::InvalidKey),
            (429, JournalErrorCode::RateLimited),
            (500, JournalErrorCode::Unavailable),
        ] {
            let err = parse_rank(
                &json!({"code":code,"msg":"secretKey=do-not-echo"}),
                "Example",
            )
            .unwrap_err();
            assert_eq!(err.code, expected);
            assert!(
                !format!("{err:?} {err} {}", serde_json::to_string(&err).unwrap())
                    .contains("do-not-echo")
            );
        }
        assert_eq!(
            http_error(StatusCode::TOO_MANY_REQUESTS).code,
            JournalErrorCode::RateLimited
        );
        assert_eq!(
            http_error(StatusCode::FOUND).code,
            JournalErrorCode::Unavailable
        );
    }
    #[test]
    fn no_rank_is_not_found_and_arbitrary_text_is_never_returned() {
        for body in [
            json!({"code":200,"data":{}}),
            json!({"code":200,"data":{"officialRank":{"all":{"sci":"secretKey=private", "sciif":"N/A"}}}}),
        ] {
            assert_eq!(
                parse_rank(&body, "Example").unwrap_err().code,
                JournalErrorCode::NotFound
            );
        }
    }
    #[test]
    fn doi_resolution_uses_container_title_and_valid_issns() {
        let (name, issns) = parse_crossref(&json!({"status":"ok","message":{"title":["Article title"], "container-title":["", "Journal title"],"ISSN":["1234-567X", "1234-567X", "bad"]}})).unwrap();
        assert_eq!(name, "Journal title");
        assert_eq!(issns, vec!["1234-567X"]);
        assert_eq!(
            parse_crossref(&json!({"status":"ok","message":{"title":["Article"]}}))
                .unwrap_err()
                .code,
            JournalErrorCode::NotFound
        );
    }
    #[test]
    fn validates_dois_and_preserves_journal_names() {
        assert!(
            matches!(query(" https://doi.org/10.1234/ABC ").unwrap(), Query::Doi(s) if s == "10.1234/abc")
        );
        assert!(
            matches!(query("Journal of A & B").unwrap(), Query::Publication(s) if s == "Journal of A & B")
        );
        for input in [
            "",
            "10.invalid/abc",
            "https://attacker.test/x",
            "10.1234/x?secretKey=test",
            "name\nvalue",
        ] {
            assert!(query(input).is_err());
        }
    }
    #[test]
    fn bodies_and_sources_are_bounded() {
        assert_eq!(
            read_json(vec![b' '; MAX_BODY as usize + 1].as_slice())
                .unwrap_err()
                .code,
            JournalErrorCode::InvalidResponse
        );
        assert!(read_json(b"not json".as_slice()).is_err());
        assert!(check_source(&Url::parse(EASY_SCHOLAR).unwrap(), EASY_SCHOLAR_HOST).is_ok());
        for url in [
            "http://www.easyscholar.cc/open",
            "https://easyscholar.cc/open",
            "https://evil.test/open",
            "https://www.easyscholar.cc:444/open",
            "https://user@www.easyscholar.cc/open",
        ] {
            assert!(check_source(&Url::parse(url).unwrap(), EASY_SCHOLAR_HOST).is_err());
        }
    }
    #[test]
    fn wire_names_match_the_frontend_contract() {
        let info = parse_rank(
            &json!({"code":200,"data":{"officialRank":{"all":{"sciif5":"1.1"}}}}),
            "Example",
        )
        .unwrap();
        let wire = serde_json::to_value(info).unwrap();
        assert_eq!(wire["impactFactor5Year"]["value"], 1.1);
        assert_eq!(wire["source"], "easyScholar");
        assert_eq!(wire["doi"], Value::Null);
    }

    #[test]
    fn recognizes_jcr_categories_without_inventing_a_year() {
        let info = parse_rank(
            &json!({"code":200,"data":{"officialRank":{"all":{"ssci":"2区"}}}}),
            "Example",
        )
        .unwrap();
        assert_eq!(
            info.jcr_quartile,
            Some(Metric {
                value: "Q2".into(),
                year: None
            })
        );
    }

    #[test]
    fn credential_requests_do_not_follow_redirects() {
        use std::{io::Write, net::TcpListener, thread};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/leak", redirect_target.local_addr().unwrap());
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        // Only the client policy is tested over loopback. The production
        // request function additionally rejects every non-HTTPS source.
        let mut url = Url::parse(&format!("http://{address}/lookup")).unwrap();
        url.query_pairs_mut()
            .append_pair("secretKey", "synthetic-test-value");
        let response = client().unwrap().get(url).send().unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        server.join().unwrap();
        assert_eq!(
            redirect_target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
