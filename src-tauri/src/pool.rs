#[derive(Default)]
pub struct SshPool;

impl SshPool {
    pub fn invalidate(&self, _id: &str) {
        // On the Unix path connections are multiplexed by the system `ssh`
        // ControlMaster and expire on their own; on the russh path we hold the
        // session ourselves and must evict it explicitly.
        #[cfg(russh_backend)]
        crate::russh_transport::invalidate(_id);
    }
}
