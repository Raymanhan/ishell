use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub tags: Vec<String>,
    pub auth_type: String,
    pub key_path: Option<String>,
    pub color: String,
    pub notes: String,
    #[serde(default)]
    pub sort_order: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_connected_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub tags: Vec<String>,
    pub auth_type: String,
    pub key_path: Option<String>,
    pub color: String,
    pub notes: String,
    #[serde(default)]
    pub sort_order: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOrderInput {
    pub id: String,
    pub group: String,
    pub sort_order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionExport {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub exported_at: u64,
    pub folders: Vec<String>,
    pub servers: Vec<ConnectionExportServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionExportServer {
    #[serde(flatten)]
    pub server: ServerRecord,
    #[serde(default)]
    pub encrypted_secret: Option<EncryptedExportSecret>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedExportSecret {
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    pub kdf: String,
    pub iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImport {
    pub folders: Vec<String>,
    pub servers: Vec<ConnectionImportServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportServer {
    #[serde(flatten)]
    pub input: ServerInput,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    pub os: String,
    pub uptime_seconds: Option<u64>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cpu_cores: Option<u64>,
    pub cpu_percent: f64,
    pub memory_total_mb: Option<u64>,
    pub memory_available_mb: Option<u64>,
    pub swap_total_mb: Option<u64>,
    pub swap_free_mb: Option<u64>,
    pub disk_used_percent: Option<f64>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub disk_mounts: Vec<DiskMount>,
    pub processes: Option<u64>,
    pub sampled_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub sampled_at: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMount {
    pub filesystem: String,
    pub mount_point: String,
    pub used_percent: f64,
    pub used_gb: f64,
    pub total_gb: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default)]
    pub link_target: Option<String>,
    #[serde(default)]
    pub target_is_dir: Option<bool>,
    pub size: Option<u64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub permissions: Option<u32>,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub transfer_id: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataPayload {
    pub session_id: String,
    pub offset: usize,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadyPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotPayload {
    pub data: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosedPayload {
    pub session_id: String,
    pub reason: String,
}
